// MySQL (a pmdev mostani adatbazisa) -> SQLite atvitel.
//
//   node scripts/ops/mysql2sqlite.mjs <cel.sqlite> [--skip=tabla1,tabla2] [--force]
//
// Kapcsolat: MYSQL_HOST, MYSQL_PORT, MYSQL_USER, MYSQL_PASSWORD, MYSQL_DATABASE kornyezeti valtozok.
//
// Menete:
//   1. uj SQLite-fajl, a sema a migrations/ mappabol (pontosan ugy, mint a szerver indulasakor),
//   2. minden SQLite-tablaba a MySQL-tabla sorai – csak a mindket oldalon letezo oszlopok,
//      a migraciok altal betoltott alapsorok helyett a MySQL tartalma kerul be,
//   3. a MySQL `rid` oszlopa (a SQLite rowid potlasa) kimarad, de a sorok ebben a sorrendben kerulnek be,
//   4. ellenorzes: tablankenti darabszam, idegenkulcs- es integritas-ellenorzes.
// A sema-elteresekrol (csak az egyik oldalon levo tabla/oszlop) jelentest ir.
import mysql from 'mysql2/promise';
import { DatabaseSync } from 'node:sqlite';
import { existsSync, rmSync } from 'node:fs';
import { migrate } from '../../src/server/runtime/d1-sqlite.mjs';

const args = process.argv.slice(2);
const out = args.find((a) => !a.startsWith('--'));
const force = args.includes('--force');
const skip = new Set(
  (args.find((a) => a.startsWith('--skip=')) || '--skip=')
    .slice(7)
    .split(',')
    .filter(Boolean),
);
if (!out) {
  console.error('Hasznalat: node scripts/ops/mysql2sqlite.mjs <cel.sqlite> [--skip=t1,t2] [--force]');
  process.exit(2);
}
if (existsSync(out)) {
  if (!force) {
    console.error(`A cel mar letezik: ${out} (felulirashoz: --force)`);
    process.exit(2);
  }
  for (const f of [out, `${out}-wal`, `${out}-shm`]) rmSync(f, { force: true });
}

const my = await mysql.createConnection({
  host: process.env.MYSQL_HOST || '127.0.0.1',
  port: Number(process.env.MYSQL_PORT || 3306),
  user: process.env.MYSQL_USER || 'root',
  password: process.env.MYSQL_PASSWORD || '',
  database: process.env.MYSQL_DATABASE,
  charset: 'utf8mb4',
  dateStrings: true,
  supportBigNumbers: true,
  bigNumberStrings: false,
});

const db = new DatabaseSync(out);
db.exec('PRAGMA foreign_keys = OFF'); // betoltes kozben a sorrend miatt; a vegen ellenorizzuk
const applied = migrate(db, 'migrations');
console.log(`Sema: ${applied.length} migracio lefuttatva.`);

const sqliteTables = db
  .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name <> 'd1_migrations' ORDER BY name")
  .all()
  .map((r) => r.name);
const mysqlTables = new Set((await my.query('SHOW TABLES'))[0].map((r) => Object.values(r)[0]));

const q = (n) => `"${n.replace(/"/g, '""')}"`;
const report = [];
const warnings = [];

for (const t of sqliteTables) {
  if (skip.has(t)) {
    db.exec(`DELETE FROM ${q(t)}`);
    report.push({ t, mysql: '-', sqlite: 0, note: 'kihagyva (--skip)' });
    continue;
  }
  if (!mysqlTables.has(t)) {
    const n = db.prepare(`SELECT COUNT(*) AS n FROM ${q(t)}`).get().n;
    warnings.push(`${t}: nincs a MySQL-ben – a migraciok szerinti allapot marad (${n} sor)`);
    report.push({ t, mysql: '-', sqlite: n, note: 'csak SQLite' });
    continue;
  }
  const sCols = db
    .prepare(`PRAGMA table_info(${q(t)})`)
    .all()
    .map((c) => c.name);
  const mCols = (await my.query(`SHOW COLUMNS FROM \`${t}\``))[0].map((c) => c.Field);
  const common = sCols.filter((c) => mCols.includes(c));
  const onlyS = sCols.filter((c) => !mCols.includes(c));
  const onlyM = mCols.filter((c) => !sCols.includes(c) && c !== 'rid');
  if (onlyS.length) warnings.push(`${t}: csak az SQLite-ban levo oszlop(ok), alapertelmezett ertekkel: ${onlyS.join(', ')}`);
  if (onlyM.length) warnings.push(`${t}: csak a MySQL-ben levo oszlop(ok), KIMARADNAK: ${onlyM.join(', ')}`);

  const order = mCols.includes('rid') ? ' ORDER BY `rid`' : '';
  const [rows] = await my.query(`SELECT ${common.map((c) => `\`${c}\``).join(', ')} FROM \`${t}\`${order}`);

  db.exec('BEGIN');
  try {
    db.exec(`DELETE FROM ${q(t)}`); // a migraciok altal betoltott alapsorok helyett a MySQL tartalma
    const ins = db.prepare(`INSERT INTO ${q(t)} (${common.map(q).join(', ')}) VALUES (${common.map(() => '?').join(', ')})`);
    for (const r of rows) ins.run(...common.map((c) => (r[c] === undefined ? null : r[c])));
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw new Error(`${t}: ${e.message}`);
  }
  const n = db.prepare(`SELECT COUNT(*) AS n FROM ${q(t)}`).get().n;
  report.push({ t, mysql: rows.length, sqlite: n, note: n === rows.length ? '' : 'ELTERES' });
}
for (const t of mysqlTables) if (!sqliteTables.includes(t)) warnings.push(`${t}: csak a MySQL-ben van – KIMARAD`);
await my.end();

const fk = db.prepare('PRAGMA foreign_key_check').all();
const integrity = db.prepare('PRAGMA integrity_check').get();
db.exec('PRAGMA journal_mode = WAL');
db.close();

console.log('\nTabla'.padEnd(20) + 'MySQL'.padStart(8) + 'SQLite'.padStart(8) + '  megjegyzes');
for (const r of report) console.log(r.t.padEnd(19) + String(r.mysql).padStart(8) + String(r.sqlite).padStart(8) + '  ' + r.note);
if (warnings.length) console.log('\nSema-elteresek:\n- ' + warnings.join('\n- '));
console.log(`\nIdegenkulcs-ellenorzes: ${fk.length ? fk.length + ' hibas hivatkozas' : 'rendben'}`);
if (fk.length) {
  const byTable = {};
  for (const f of fk) byTable[`${f.table} -> ${f.parent}`] = (byTable[`${f.table} -> ${f.parent}`] || 0) + 1;
  for (const [k, v] of Object.entries(byTable)) console.log(`  ${k}: ${v}`);
}
console.log(`Integritas: ${Object.values(integrity)[0]}`);
const bad = report.filter((r) => r.note === 'ELTERES');
if (bad.length) {
  console.error(`\nHIBA: ${bad.length} tablaban elter a darabszam.`);
  process.exit(1);
}
console.log(`\nKesz: ${out}`);
