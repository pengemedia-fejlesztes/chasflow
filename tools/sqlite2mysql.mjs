// SQLite (D1) migracios SQL -> MySQL 5.7 sema. A kimenetet kezzel at kell nezni.
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const dir = process.argv[2] || 'migrations';
const out = process.argv[3] || 'mysql-schema.sql';

const files = readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
let sql = files.map((f) => `-- === ${f} ===\n` + readFileSync(join(dir, f), 'utf8')).join('\n\n');

sql = sql
  // elsodleges kulcsok
  .replace(/INTEGER\s+PRIMARY\s+KEY\s+AUTOINCREMENT/gi, 'INT NOT NULL AUTO_INCREMENT PRIMARY KEY')
  .replace(/INTEGER\s+PRIMARY\s+KEY/gi, 'INT NOT NULL PRIMARY KEY')
  // szoveges kulcsok/indexelt mezok: MySQL-ben hosszkorlat kell
  .replace(/TEXT\s+PRIMARY\s+KEY/gi, 'VARCHAR(191) NOT NULL PRIMARY KEY')
  .replace(/TEXT\s+NOT\s+NULL\s+UNIQUE(\s+COLLATE\s+NOCASE)?/gi, 'VARCHAR(191) NOT NULL UNIQUE')
  .replace(/\s+COLLATE\s+NOCASE/gi, '')
  // a maradek TEXT marad TEXT, de az index-ben szereplo oszlopokat kesobb kezzel kell VARCHAR-ra tenni
  .replace(/\bINTEGER\b/g, 'BIGINT')
  .replace(/\bREAL\b/g, 'DOUBLE')
  // SQLite CHECK: MySQL 5.7 nem kenyszeriti ki, inkabb kivesszuk, hogy ne zavarjon
  .replace(/\s+CHECK\s*\((?:[^()]|\([^()]*\))*\)/gi, '')
  // tabla-motor
  .replace(/\);/g, ') ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;');

writeFileSync(out, sql);
console.log('kesz:', out, sql.split('\n').length, 'sor');
