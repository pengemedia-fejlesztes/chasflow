// A termékszinkron futtatása valódi SQLite-on (D1-szerű burkolóval): táblák, készlet-oszlop pótlása, feltöltés, ismétlés.
import { describe, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { ensureCatalog, loadCatalog, syncCatalog } from '../../src/server/app/catalog';

function d1(db: DatabaseSync) {
  const stmt = (sql: string, args: unknown[] = []) => ({
    bind: (...a: unknown[]) => stmt(sql, a),
    all: async () => ({ results: db.prepare(sql).all(...(args as any[])) }),
    first: async () => db.prepare(sql).get(...(args as any[])) ?? null,
    run: async () => (db.prepare(sql).run(...(args as any[])), { success: true }),
  });
  return { prepare: (sql: string) => stmt(sql), batch: async (ss: any[]) => Promise.all(ss.map((s) => s.all().catch(() => s.run()))) };
}

describe('termékszinkron SQLite-on', () => {
  it('régi (készlet nélküli) táblát kiegészít, a partnerek terveiből feltölt, másodszorra nem duplikál', async () => {
    const db = new DatabaseSync(':memory:');
    db.exec(`CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT);
      CREATE TABLE groups (id TEXT, section TEXT, label TEXT);
      CREATE TABLE leaves (id TEXT, group_id TEXT, label TEXT);
      CREATE TABLE series (id TEXT, rep TEXT);
      CREATE TABLE entries (leaf_id TEXT, kind TEXT, name TEXT, amount REAL, date TEXT, period TEXT, series_id TEXT, tentative INTEGER);
      CREATE TABLE products (id VARCHAR(40) NOT NULL PRIMARY KEY, name VARCHAR(200) NOT NULL, kind VARCHAR(20) NOT NULL DEFAULT 'szolgaltatas', unit VARCHAR(20) NOT NULL DEFAULT 'db', price DOUBLE NOT NULL DEFAULT 0, vat VARCHAR(10) NOT NULL DEFAULT '27', currency VARCHAR(3) NOT NULL DEFAULT 'HUF', billing VARCHAR(12) NOT NULL DEFAULT 'havi', sku VARCHAR(60), note TEXT, archived INTEGER NOT NULL DEFAULT 0, updated_at BIGINT NOT NULL);
      INSERT INTO groups VALUES ('gi','in','Projektek'),('ga','in','Ajánlatok');
      INSERT INTO leaves VALUES ('k','gi','Kalmia'),('m','ga','M3');
      INSERT INTO series VALUES ('s1','monthly');`);
    const t = new Date();
    const ym = (n: number) => new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth() + n, 10)).toISOString().slice(0, 10);
    for (let i = 0; i < 4; i++) db.prepare("INSERT INTO entries VALUES ('k','plan','Marketing tanácsadás',1270000,?,NULL,'s1',0)").run(ym(i));
    db.prepare("INSERT INTO entries VALUES ('m','plan','M3-weboldal',1270000,?,NULL,NULL,1)").run(ym(1));
    const env = { DB: d1(db) } as any;
    expect(await ensureCatalog(env)).toBe(true);
    const r1 = await syncCatalog(env);
    expect(r1).toEqual({ products: 2, assigns: 1 });
    expect(await syncCatalog(env)).toEqual({ products: 0, assigns: 0 });
    const c = await loadCatalog(env);
    expect(c.products.map((p) => [p.name, p.price, p.grp ?? null])).toEqual([
      ['M3-weboldal', 1000000, null],
      ['Marketing tanácsadás', 1000000, null],
    ]);
    expect(c.partnerProducts).toHaveLength(1);
    expect(c.partnerProducts[0]).toMatchObject({ partner_key: 'kalmia', qty: 1, price: null });
  });
});
