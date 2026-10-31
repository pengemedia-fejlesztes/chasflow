// Gyanus cegnev-parok SZIGORU szureesel: csak az, ami nagy valoszinuseggel ugyanaz a ceg.
// Jelek: (1) azonos adoszam, (2) az egyik nev magja benne van a masikban,
//        (3) nagyon hasonlo nev (Levenshtein-arany >= 0.85),
//        (4) kozos RITKA szo (az egesz listaban max 2 nevben fordul elo) + legalabb 0,6 hasonlosag.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDb } from './d1-mysql.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
try {
  for (const line of readFileSync(join(ROOT, '.env'), 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && process.env[m[1]] === undefined) {
      let v = m[2];
      if (v.startsWith('"') && v.endsWith('"')) v = v.slice(1, -1).replace(/\\n/g, '\n');
      process.env[m[1]] = v;
    }
  }
} catch {}

const LEGAL = /\b(kft|zrt|nyrt|bt|kkt|ev|e v|ltd|limited|gmbh|inc|llc|sro|s r o|kozkereseti tarsasag|egyeni vallalkozo)\b/g;
const STOP = new Set(
  ('es az a kozpont szolgaltato kereskedelmi tanacsado korlatolt felelossegu tarsasag hungary magyarorszag group csoport trade trading invest holding studio net hu com media marketing service services solutions system systems tech technologies plusz plus pro international europe euro global kozhasznu alapitvany egyesulet bank card payment simple fizetes atutalas utalas kartya vasarlas budapest bp web online shop store office center centrum team partner partners company rt nonprofit').split(
    ' ',
  ),
);
const norm = (s) =>
  String(s || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(LEGAL, ' ')
    .replace(/\s+/g, ' ')
    .trim();

function lev(a, b) {
  const m = a.length, n = b.length;
  if (!m || !n) return Math.max(m, n);
  const d = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    let prev = d[0];
    d[0] = i;
    for (let j = 1; j <= n; j++) {
      const tmp = d[j];
      d[j] = Math.min(d[j] + 1, d[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = tmp;
    }
  }
  return d[n];
}
const hasonlosag = (a, b) => 1 - lev(a, b) / Math.max(a.length, b.length);

const db = createDb({ host: process.env.DB_HOST, user: process.env.DB_USER, password: process.env.DB_PASSWORD, database: process.env.DB_NAME });

const uniq = new Map();
for (const [src, sql] of [
  ['bank', "SELECT DISTINCT partner AS n FROM bank_tx WHERE partner <> ''"],
  ['billingo', "SELECT DISTINCT partner AS n FROM billingo_docs WHERE partner <> ''"],
  ['nav', "SELECT DISTINCT partner_name AS n FROM nav_invoices WHERE partner_name <> ''"],
  ['partnertorzs', 'SELECT DISTINCT name AS n FROM partners'],
]) {
  const r = await db.prepare(sql).all();
  for (const x of r.results) {
    const raw = String(x.n || '').trim();
    if (!raw || uniq.has(raw)) continue;
    uniq.set(raw, { src, raw, key: norm(raw) });
  }
}
const list = [...uniq.values()].filter((x) => x.key.length >= 4);

// szo-gyakorisag (ritka szo = legfeljebb 2 nevben szerepel)
const df = new Map();
for (const x of list) for (const w of new Set(x.key.split(' '))) df.set(w, (df.get(w) || 0) + 1);
const ritkaSzavak = (k) => k.split(' ').filter((w) => w.length >= 6 && !STOP.has(w) && (df.get(w) || 0) <= 2);
const mag = (k) => k.split(' ').filter((w) => w.length >= 4 && !STOP.has(w)).join(' ');

const parok = [];
for (let i = 0; i < list.length; i++) {
  for (let j = i + 1; j < list.length; j++) {
    const a = list[i], b = list[j];
    if (a.key === b.key) continue;
    const ma = mag(a.key), mb = mag(b.key);
    if (!ma || !mb) continue;
    const sim = hasonlosag(a.key, b.key);
    const tartalmaz = (ma.length >= 6 && b.key.includes(ma)) || (mb.length >= 6 && a.key.includes(mb));
    const kozosRitka = ritkaSzavak(a.key).filter((w) => ritkaSzavak(b.key).includes(w));
    let ok = '';
    if (tartalmaz) ok = 'az egyik név magja benne van a másikban';
    else if (sim >= 0.85) ok = `szinte azonos név (${Math.round(sim * 100)}%)`;
    else if (kozosRitka.length && sim >= 0.6) ok = `ritka közös szó: ${kozosRitka.join(', ')} (${Math.round(sim * 100)}%)`;
    if (ok) parok.push({ a, b, ok, sim });
  }
}
parok.sort((x, y) => y.sim - x.sim);

const out = [`VALÓSZÍNŰLEG UGYANAZ A CÉG – ${parok.length} pár`, ''];
for (const p of parok) out.push(`[${p.a.src}] ${p.a.raw}\n[${p.b.src}] ${p.b.raw}\n   → ${p.ok}\n`);
console.log(out.join('\n'));
process.exit(0);
