// D1 (SQLite) dump -> MySQL 5.7 dump. Sema + adat egyben.
import { readFileSync, writeFileSync } from 'node:fs';

const RES = new Set(['key', 'order', 'group', 'rank', 'status', 'range', 'system', 'read', 'write', 'call', 'function', 'option', 'usage', 'lines', 'rows', 'signal', 'partition', 'groups', 'leave', 'leaves']);
const src = readFileSync(process.argv[2] || 'd1-dump.sql', 'utf8');
const lines = src.split('\n');

// elso menet: melyik oszlopok szerepelnek indexben/UNIQUE-ban -> azok nem lehetnek TEXT
const INDEXED = new Set();
for (const l of lines) {
  const mi = l.match(/CREATE\s+(?:UNIQUE\s+)?INDEX[^(]*\(([^)]*)\)/i);
  if (mi) for (const c of mi[1].split(',')) INDEXED.add(c.trim().replace(/["`]/g, '').split(/\s+/)[0].toLowerCase());
  const mu = l.match(/UNIQUE\s*\(([^)]*)\)/i);
  if (mu) for (const c of mu[1].split(',')) INDEXED.add(c.trim().replace(/["`]/g, '').split(/\s+/)[0].toLowerCase());
}

const outDdl = [];
const outDml = [];
let buf = null;

function quoteIdent(name) {
  return '`' + name.replace(/`/g, '') + '`';
}

function convertCreate(stmt) {
  // tablanev: CREATE TABLE IF NOT EXISTS "nev"( ... );
  const m = stmt.match(/CREATE TABLE(?: IF NOT EXISTS)? ["`]?([\w]+)["`]?\s*\(([\s\S]*)\)\s*;?\s*$/i);
  if (!m) return null;
  const table = m[1];
  if (table === 'sqlite_sequence' || table === 'd1_migrations') return null;
  let body = m[2].replace(/--[^\n]*/g, '');
  // oszlopok/megkotesek szetvagasa a legfelso szintu vesszok menten
  const parts = [];
  let depth = 0, cur = '';
  for (const ch of body) {
    if (ch === '(') depth++;
    if (ch === ')') depth--;
    if (ch === ',' && depth === 0) { parts.push(cur); cur = ''; continue; }
    cur += ch;
  }
  if (cur.trim()) parts.push(cur);

  // tabla-szintu PRIMARY KEY / UNIQUE oszlopai sem lehetnek TEXT
  const localIdx = new Set();
  for (const p0 of parts) {
    const mm = p0.trim().match(/^(?:PRIMARY KEY|UNIQUE)\s*\(([^)]*)\)/i);
    if (mm) for (const c of mm[1].split(',')) localIdx.add(c.trim().replace(/["`]/g, '').toLowerCase());
  }

  const cols = [];
  for (let p of parts) {
    p = p.trim().replace(/\s+/g, ' ');
    if (!p) continue;
    if (/^(PRIMARY KEY|UNIQUE|FOREIGN KEY|CHECK|CONSTRAINT)/i.test(p)) {
      if (/^CHECK/i.test(p)) continue; // MySQL 5.7 nem kenyszeriti ki
      if (/^FOREIGN KEY/i.test(p)) continue; // a hivatkozasokat nem visszuk at
      cols.push(p.replace(/"(\w+)"/g, (s, n) => quoteIdent(n)));
      continue;
    }
    const cm = p.match(/^["`]?(\w+)["`]?\s+(.*)$/);
    if (!cm) continue;
    const name = cm[1];
    let rest = cm[2];
    const isPk = /PRIMARY KEY/i.test(rest);
    const isUnique = /UNIQUE/i.test(rest);
    const notNull = /NOT NULL/i.test(rest);
    const defMatch = rest.match(/DEFAULT\s+('[^']*'|[-\w().]+)/i);
    let type = rest.split(/\s+/)[0].toUpperCase();
    let myType;
    if (/^INTEGER$/.test(type)) myType = 'BIGINT';
    else if (/^REAL|^NUMERIC|^DOUBLE|^FLOAT/.test(type)) myType = 'DOUBLE';
    else if (/^TIMESTAMP|^DATETIME/.test(type)) myType = 'VARCHAR(32)';
    else if (/^BLOB/.test(type)) myType = 'LONGBLOB';
    else myType = (isPk || isUnique || INDEXED.has(name.toLowerCase()) || localIdx.has(name.toLowerCase())) ? 'VARCHAR(191)' : 'TEXT';
    if (isPk && myType === 'BIGINT') myType = 'BIGINT NOT NULL' + (/AUTOINCREMENT/i.test(rest) ? ' AUTO_INCREMENT' : '');
    let col = `${quoteIdent(name)} ${myType}`;
    if (!/NOT NULL/.test(col) && notNull) col += ' NOT NULL';
    if (defMatch && !/^TEXT$|^LONGBLOB$/.test(myType)) col += ` DEFAULT ${defMatch[1]}`;
    if (isPk) col += ' PRIMARY KEY';
    else if (isUnique) col += ' UNIQUE';
    cols.push(col);
  }
  return `DROP TABLE IF EXISTS ${quoteIdent(table)};\nCREATE TABLE ${quoteIdent(table)} (\n  ${cols.join(',\n  ')}\n) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;`;
}

function convertIndex(stmt) {
  let s = stmt.replace(/CREATE\s+(UNIQUE\s+)?INDEX(\s+IF\s+NOT\s+EXISTS)?/i, (m, u) => `CREATE ${u ? 'UNIQUE ' : ''}INDEX`);
  s = s.replace(/\s+WHERE\s+[^;]*;/i, ';');
  s = s.replace(/"(\w+)"/g, (m, n) => quoteIdent(n));
  // oszlopnev-idezes a listaban
  s = s.replace(/\(([^)]*)\)/, (m, inner) =>
    '(' + inner.split(',').map((c) => {
      const t = c.trim();
      return RES.has(t.toLowerCase()) ? quoteIdent(t) : t;
    }).join(', ') + ')');
  return s;
}

for (let raw of lines) {
  const line = raw.trimEnd();
  if (!line.trim()) continue;
  if (/^PRAGMA/i.test(line)) continue;
  if (/^DELETE FROM sqlite_sequence/i.test(line)) continue;
  if (/^INSERT INTO "?sqlite_sequence/i.test(line)) continue;
  if (/^INSERT INTO "?d1_migrations/i.test(line)) continue;

  if (buf !== null) {
    buf += '\n' + line;
    if (/;\s*$/.test(line)) {
      const conv = convertCreate(buf);
      if (conv) outDdl.push(conv);
      buf = null;
    }
    continue;
  }
  if (/^CREATE TABLE/i.test(line)) {
    if (/;\s*$/.test(line)) {
      const conv = convertCreate(line);
      if (conv) outDdl.push(conv);
    } else buf = line;
    continue;
  }
  if (/^CREATE\s+(UNIQUE\s+)?INDEX/i.test(line)) { outDdl.push(convertIndex(line)); continue; }
  if (/^INSERT INTO/i.test(line)) {
    let s = line.replace(/^INSERT INTO "(\w+)"/i, (m, t) => `INSERT INTO ${quoteIdent(t)}`);
    s = s.replace(/\(("[\w]+"(?:,"[\w]+")*)\)\s+VALUES/i, (m, cols) =>
      '(' + cols.split(',').map((c) => quoteIdent(c.replace(/"/g, ''))).join(',') + ') VALUES');
    outDml.push(s);
    continue;
  }
}

const out = ['SET FOREIGN_KEY_CHECKS=0;', 'SET sql_mode="NO_ENGINE_SUBSTITUTION";', ...outDdl, ...outDml, 'SET FOREIGN_KEY_CHECKS=1;'].join('\n');
writeFileSync(process.argv[3] || 'mysql-dump.sql', out);
console.log('tablak:', outDdl.filter((s) => s.startsWith('DROP')).length, 'insert:', outDml.length);
