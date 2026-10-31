// Cegnev-valtozatok osszevonasa: a banki/Billingo/NAV nevek a program sajat
// nev-azonositojaval csoportosulnak, es a partnertorzsbe kerulnek alternativ nevkent.
// Futtatas:  node server/partner-unify.mjs [--write]
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

const WRITE = process.argv.includes('--write');
const LEGAL = /\b(kft|zrt|nyrt|bt|kkt|ev|e v|ltd|limited|gmbh|inc|llc|sro|s r o|kozkereseti tarsasag|egyeni vallalkozo)\b/g;
const normalizeText = (s) =>
  String(s || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
const partnerKey = (p) => normalizeText(p).replace(LEGAL, ' ').replace(/\s+/g, ' ').trim();

const db = createDb({
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
});

const sources = [
  ['bank', "SELECT DISTINCT partner AS n FROM bank_tx WHERE partner IS NOT NULL AND partner <> ''"],
  ['billingo', "SELECT DISTINCT partner AS n FROM billingo_docs WHERE partner IS NOT NULL AND partner <> ''"],
  ['nav', "SELECT DISTINCT partner_name AS n FROM nav_invoices WHERE partner_name IS NOT NULL AND partner_name <> ''"],
];

const byKey = new Map(); // kulcs -> { nevek: Set }
for (const [, sql] of sources) {
  const r = await db.prepare(sql).all();
  for (const row of r.results) {
    const key = partnerKey(row.n);
    if (!key || key.length < 3) continue;
    if (!byKey.has(key)) byKey.set(key, new Set());
    byKey.get(key).add(String(row.n).trim());
  }
}

const existing = await db.prepare('SELECT `key`, name, aliases FROM partners').all();
const partnerByKey = new Map();
for (const p of existing.results) partnerByKey.set(String(p.key), p);

let ujPartner = 0;
let ujAlias = 0;
const stmts = [];
const t = Date.now();

for (const [key, nameSet] of byKey) {
  const names = [...nameSet];
  // a legbeszedesebb (leghosszabb) alak legyen a megjelenitendo nev
  const display = names.slice().sort((a, b) => b.length - a.length)[0];
  const p = partnerByKey.get(key);
  if (!p) {
    if (names.length < 2) continue; // egyetlen alaknal nincs mit egyseresiteni
    ujPartner++;
    stmts.push(
      db
        .prepare('INSERT INTO partners (`key`, name, kind, aliases, updated_at) VALUES (?, ?, NULL, ?, ?)')
        .bind(key, display, JSON.stringify(names.filter((n) => n !== display)), t),
    );
    continue;
  }
  let aliases = [];
  try {
    aliases = JSON.parse(p.aliases || '[]');
  } catch {}
  const before = new Set(aliases.map((a) => String(a)));
  for (const n of names) if (n !== p.name && !before.has(n)) (aliases.push(n), ujAlias++);
  if (aliases.length !== before.size)
    stmts.push(db.prepare('UPDATE partners SET aliases = ?, updated_at = ? WHERE `key` = ?').bind(JSON.stringify(aliases), t, key));
}

console.log(
  `nevvaltozatok: ${[...byKey.values()].reduce((s, v) => s + v.size, 0)} | cegek (osszevonva): ${byKey.size} | uj partner: ${ujPartner} | uj alternativ nev: ${ujAlias}`,
);
if (!WRITE) {
  console.log('PROBA mod — iras nem tortent. Inditsd --write kapcsoloval.');
  process.exit(0);
}
for (let i = 0; i < stmts.length; i += 50) await db.batch(stmts.slice(i, i + 50));
console.log('mentve:', stmts.length, 'muvelet');
process.exit(0);
