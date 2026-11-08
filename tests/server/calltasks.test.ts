import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { callDate, defaultCallDays } from '../../src/shared/tasks';
import { ensureCatalog } from '../../src/server/app/catalog';
import { generateCallTasks, loadTasks } from '../../src/server/app/tasks';
import { todayHu } from '../../src/server/app/util';
import { addMonths } from '../../src/shared/model';

describe('hívás a számlázás előtt', () => {
  it('a számlázási hónap első munkanapja előtt N nappal, munkanapra igazítva', () => {
    // 2027. január: első munkanap jan. 4. (hétfő); 30 nappal előtte dec. 5. szombat → dec. 4. péntek
    expect(callDate('2027-01', 30)).toBe('2026-12-04');
    expect(defaultCallDays('eves')).toBe(30);
    expect(defaultCallDays('havi')).toBeNull();
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

describe('hívás-feladatok SQLite-on', () => {
  it('éves terméknél egyszer jön létre Telefon feladat a következő számlázás előtt', async () => {
    const db = new DatabaseSync(':memory:');
    db.exec(`CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT);
      CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT, email TEXT, role TEXT, disabled INTEGER DEFAULT 0);
      INSERT INTO users VALUES (1, 'Laci', 'l@x', 'admin', 0);
      CREATE TABLE leaves (id TEXT, group_id TEXT, label TEXT); INSERT INTO leaves VALUES ('l', 'g', 'Autocom');
      CREATE TABLE partners (key TEXT PRIMARY KEY, name TEXT);`);
    const env = { DB: d1(db) } as any;
    await ensureCatalog(env);
    const next = addMonths(todayHu().slice(0, 7), 1);
    db.prepare(
      "INSERT INTO products (id, name, kind, unit, price, vat, currency, billing, call_days, archived, updated_at) VALUES ('p', 'Domain és tárhely', 'szolgaltatas', 'év', 37800, '27', 'HUF', 'eves', 30, 0, 1)",
    ).run();
    db.prepare(
      "INSERT INTO partner_products (id, partner_key, product_id, qty, price, billing, start_ym, end_ym, note, updated_at) VALUES ('a', 'autocom', 'p', 1, NULL, NULL, ?, NULL, NULL, 1)",
    ).run(next);
    const { tasks } = await loadTasks(env, { id: 1, role: 'admin' } as any);
    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toMatchObject({ type: 'telefon', partner_key: 'autocom', assignee_id: 1, status: 'nyitott' });
    expect(tasks[0].title).toMatch(/Hívás: Autocom – Domain és tárhely/);
    expect(await generateCallTasks(env)).toBe(0);
  });
});
