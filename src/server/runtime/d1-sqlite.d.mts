// Típusok a d1-sqlite.mjs-hez (a tesztek TypeScriptből használják).
import type { DatabaseSync } from 'node:sqlite';
import type { Db } from '../app/platform';

export declare class SqliteD1 implements Db {
  constructor(db: DatabaseSync);
  prepare: Db['prepare'];
  batch: Db['batch'];
  exec: Db['exec'];
}
export declare function migrate(db: DatabaseSync, dir: string): string[];
export declare function createSqliteDb(cfg: { path: string; migrationsDir?: string }): SqliteD1;
