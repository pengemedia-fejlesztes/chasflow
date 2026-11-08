import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { inventory, toCsv } from '../../src/shared/stock';
import { loadStock, handleStock } from '../../src/server/app/stock';

describe('készlet: raktári − lefoglalt = elérhető', () => {
  it('foglalás: egyszeri csak a folyó/későbbi hónapra, ismétlődő amíg nem zárult le', () => {
    const products = [
      { id: 'p', kind: 'termek', billing: 'egyszeri' },
      { id: 's', kind: 'szolgaltatas', billing: 'havi' },
    ] as any;
    const assigns = [
      { id: 'a', product_id: 'p', qty: 1, billing: null, start_ym: '2026-11', end_ym: null },
      { id: 'b', product_id: 'p', qty: 5, billing: null, start_ym: '2026-09', end_ym: null },
      { id: 'c', product_id: 's', qty: 2, billing: null, start_ym: '2026-01', end_ym: '2026-10' },
    ] as any;
    const inv = inventory(products, [{ product_id: 'p', warehouse_id: 'w', qty: 0 }], assigns, '2026-11');
    expect(inv.get('p')).toMatchObject({ onHand: 0, reserved: 1, available: -1, tracked: true });
    expect(inv.get('s')).toMatchObject({ reserved: 0, tracked: false });
    expect(toCsv([['a;b', 1.5]])).toBe('﻿"a;b";1,5');
  });
});

function d1(db: DatabaseSync) {
  const stmt = (sql: string, args: unknown[] = []) => ({
    bind: (...a: unknown[]) => stmt(sql, a),
    all: async () => ({ results: db.prepare(sql).all(...(args as any[])) }),
    first: async () => db.prepare(sql).get(...(args as any[])) ?? null,
    run: async () => (db.prepare(sql).run(...(args as any[])), { success: true }),
  });
  return { prepare: (sql: string) => stmt(sql), batch: async (ss: any[]) => Promise.all(ss.map((s) => s.all())) };
}

describe('raktár SQLite-on', () => {
  it('régi készlet → nyitókészlet; bevét, kiadás, leltár, átvezetés', async () => {
    const db = new DatabaseSync(':memory:');
    db.exec(`CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT);
      CREATE TABLE change_log (id INTEGER PRIMARY KEY, ts INTEGER, user_id INTEGER, action TEXT, summary TEXT, leaf_ids TEXT, items TEXT, undo TEXT);
      CREATE TABLE products (id VARCHAR(40) NOT NULL PRIMARY KEY, name VARCHAR(200) NOT NULL, kind VARCHAR(20) NOT NULL DEFAULT 'termek', unit VARCHAR(20) NOT NULL DEFAULT 'db', price DOUBLE NOT NULL DEFAULT 0, vat VARCHAR(10) NOT NULL DEFAULT '27', currency VARCHAR(3) NOT NULL DEFAULT 'HUF', billing VARCHAR(12) NOT NULL DEFAULT 'egyszeri', sku VARCHAR(60), note TEXT, stock DOUBLE, archived INTEGER NOT NULL DEFAULT 0, updated_at BIGINT NOT NULL);
      INSERT INTO products (id, name, stock, updated_at) VALUES ('p1', 'Pohár', 10, 1);`);
    const env = { DB: d1(db) } as any;
    const u = { id: 1, role: 'admin' } as any;
    const call = (path: string, body: unknown, method = 'POST') =>
      handleStock(env, new Request('https://x' + path, { method, body: JSON.stringify(body) }), path, u);
    let s = await loadStock(env);
    expect(s.warehouses.map((w) => w.name)).toEqual(['Központi raktár']);
    expect(s.stockLevels).toEqual([{ product_id: 'p1', warehouse_id: 'wh-main', qty: 10 }]);
    const w2: any = await (await call('/api/warehouses', { name: 'Bolt' }))!.json();
    await call('/api/stock-moves', { kind: 'bevet', product_id: 'p1', warehouse_id: 'wh-main', qty: '5' });
    await call('/api/stock-moves', { kind: 'kiadas', product_id: 'p1', warehouse_id: 'wh-main', qty: '3' });
    await call('/api/stock-moves', { kind: 'atvezetes', product_id: 'p1', warehouse_id: 'wh-main', to_warehouse_id: w2.id, qty: '2' });
    await call('/api/stock-moves', { kind: 'korrekcio', product_id: 'p1', warehouse_id: w2.id, qty: '1' });
    s = await loadStock(env);
    const lv = Object.fromEntries(s.stockLevels.map((l) => [l.warehouse_id, l.qty]));
    expect(lv).toEqual({ 'wh-main': 10, [w2.id]: 1 });
    await expect(call('/api/stock-moves', { kind: 'kiadas', product_id: 'p1', warehouse_id: 'wh-main', qty: '0' })).rejects.toThrow(/nagyobb/);
    // átvezetés törlése a párját is viszi
    const tr = s.stockMoves.find((m) => m.kind === 'atvezetes')!;
    await call('/api/stock-moves/' + tr.id, {}, 'DELETE');
    s = await loadStock(env);
    expect(s.stockMoves.filter((m) => m.kind === 'atvezetes')).toHaveLength(0);
  });
});
