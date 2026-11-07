// D1-kompatibilis reteg SQLite folott (a Node beepitett node:sqlite moduljaval).
// A Worker kodja valtozatlanul hasznalja:
//   env.DB.prepare(sql).bind(...).all() / .first() / .run() / .raw()  es  env.DB.batch([...]) / env.DB.exec(sql)
// A D1 maga is SQLite, ezert itt NINCS nyelvjaras-forditas (szemben a d1-mysql.mjs-sel).
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

/** A D1 a JS-erteket igy koti: undefined -> null, boolean -> 0/1. A node:sqlite ezeket nem fogadja el. */
function bindValue(v) {
  if (v === undefined) return null;
  if (typeof v === 'boolean') return v ? 1 : 0;
  return v;
}

class Stmt {
  constructor(db, sql, args = []) {
    this.db = db;
    this.sql = sql;
    this.args = args;
  }
  bind(...args) {
    return new Stmt(this.db, this.sql, args.map(bindValue));
  }
  prepared() {
    return this.db.prepare(this.sql);
  }
  async all() {
    return { results: this.prepared().all(...this.args), success: true, meta: {} };
  }
  async first(col) {
    const r = this.prepared().get(...this.args);
    if (!r) return null;
    return col === undefined ? r : (r[col] ?? null);
  }
  async run() {
    return this.execute();
  }
  async raw() {
    return this.prepared()
      .all(...this.args)
      .map((r) => Object.values(r));
  }
  /** Szinkron vegrehajtas (a batch tranzakciojan belul is ezt hivjuk). */
  execute() {
    const st = this.prepared();
    if (st.columns().length) return { results: st.all(...this.args), success: true, meta: {} };
    const r = st.run(...this.args);
    return {
      results: [],
      success: true,
      meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid), rows_written: Number(r.changes), rows_read: 0 },
    };
  }
}

export class SqliteD1 {
  constructor(db) {
    this.db = db;
  }
  prepare(sql) {
    return new Stmt(this.db, sql);
  }
  /** A D1 batch egyetlen tranzakcio: barmelyik utasitas hibajanal semmi nem marad meg. */
  async batch(stmts) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const out = stmts.map((s) => s.execute());
      this.db.exec('COMMIT');
      return out;
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }
  async exec(sql) {
    this.db.exec(sql);
    return { count: 1, duration: 0 };
  }
}

/**
 * A migrations/ mappa meg nem futtatott fajljainak lefuttatasa, a wrangler D1-gyel azonos
 * nyilvantartassal (d1_migrations tabla), igy egy D1-exportbol importalt adatbazis is folytathato.
 * Minden migracio kulon tranzakcioban fut: hiba eseten az adott fajl semmit nem modosit.
 */
export function migrate(db, dir) {
  db.exec(`CREATE TABLE IF NOT EXISTS d1_migrations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT UNIQUE,
    applied_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`);
  const done = new Set(db.prepare('SELECT name FROM d1_migrations').all().map((r) => r.name));
  const files = readdirSync(dir)
    .filter((n) => n.endsWith('.sql'))
    .sort();
  const applied = [];
  for (const name of files) {
    if (done.has(name)) continue;
    db.exec('BEGIN IMMEDIATE');
    try {
      db.exec(readFileSync(join(dir, name), 'utf8'));
      db.prepare('INSERT INTO d1_migrations (name) VALUES (?)').run(name);
      db.exec('COMMIT');
      applied.push(name);
    } catch (e) {
      db.exec('ROLLBACK');
      throw new Error(`Migracio hiba (${name}): ${e.message}`);
    }
  }
  return applied;
}

/**
 * cfg.path: az adatbazis-fajl utvonala; cfg.migrationsDir: ha meg van adva, indulaskor migral.
 * WAL mod + busy_timeout: tobb folyamat (web + cron) is hasznalhatja egyszerre.
 */
export function createSqliteDb(cfg) {
  mkdirSync(dirname(cfg.path), { recursive: true });
  const db = new DatabaseSync(cfg.path);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA busy_timeout = 5000');
  db.exec('PRAGMA foreign_keys = ON'); // a D1 is bekapcsolt idegenkulcs-ellenorzessel fut
  if (cfg.migrationsDir) {
    const applied = migrate(db, cfg.migrationsDir);
    if (applied.length) console.log(`SQLite migraciok lefuttatva: ${applied.join(', ')}`);
  }
  return new SqliteD1(db);
}
