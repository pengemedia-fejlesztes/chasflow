// A tervtetelek nevebol kiszedi a beleegetett honapot (a honap mostantol megjeleniteskor kerul hozza).
// Futtatas: node server/nev-alapra.mjs [--write]
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

const MONTHS = 'január|február|március|április|május|június|július|augusztus|szeptember|október|november|december';
const SUFFIX = new RegExp(`\\s*(?:[–-]\\s*)?(\\d{4}\\.?\\s*)?(${MONTHS})\\s*$`, 'i');
const baseName = (n) => String(n || '').replace(SUFFIX, '').trim();

const WRITE = process.argv.includes('--write');
const db = createDb({ host: process.env.DB_HOST, user: process.env.DB_USER, password: process.env.DB_PASSWORD, database: process.env.DB_NAME });

const r = await db.prepare("SELECT id, name, date, period FROM entries WHERE kind = 'plan'").all();
const upd = [];
for (const e of r.results) {
  const b = baseName(e.name);
  if (b && b !== e.name) upd.push([e.id, b, e.period || String(e.date).slice(0, 7)]);
}
console.log(`tervtetel: ${r.results.length} | nevbol honap kiszedve: ${upd.length}`);
if (!WRITE) {
  for (const [, b] of upd.slice(0, 5)) console.log('   pl.', b);
  console.log('PROBA mod – iras nem tortent.');
  process.exit(0);
}
const stmts = upd.map(([id, b, ym]) => db.prepare('UPDATE entries SET name = ?, period = COALESCE(period, ?) WHERE id = ?').bind(b, ym, id));
for (let i = 0; i < stmts.length; i += 50) await db.batch(stmts.slice(i, i + 50));
console.log('mentve:', stmts.length);
process.exit(0);
