import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { cleanTask, isOverdue, onDay, weekDays, weekStart } from '../shared/tasks';
import { handleTasks, loadTasks } from '../worker/tasks';

describe('feladatok: segédfüggvények', () => {
  it('hét hétfője, napok, többnapos feladat, lejárt', () => {
    expect(weekStart('2026-11-08')).toBe('2026-11-02');
    expect(weekStart('2026-11-09')).toBe('2026-11-09');
    expect(weekDays('2026-11-02')).toHaveLength(7);
    expect(onDay({ due_date: '2026-11-03', end_date: '2026-11-05' }, '2026-11-04')).toBe(true);
    expect(onDay({ due_date: '2026-11-03', end_date: null }, '2026-11-04')).toBe(false);
    expect(isOverdue({ status: 'nyitott', due_date: '2026-11-03', end_date: null }, '2026-11-08')).toBe(true);
    expect(isOverdue({ status: 'kesz', due_date: '2026-11-03', end_date: null }, '2026-11-08')).toBe(false);
  });
  it('ellenőrzés: kötelező leírás, dátum, időpont formátum', () => {
    expect(() => cleanTask({ title: '', due_date: '2026-11-08' })).toThrow(/leírást/);
    expect(() => cleanTask({ title: 'x', due_date: '2026-11-08', due_time: '25:00' })).toThrow(/időpont/);
    expect(() => cleanTask({ title: 'x', due_date: '2026-11-08', end_date: '2026-11-01' })).toThrow(/záró/);
    expect(cleanTask({ title: ' Hívás ', type: 'bogus', due_date: '2026-11-08', due_time: '09:30' })).toMatchObject({
      title: 'Hívás',
      type: 'egyeb',
      due_time: '09:30',
      status: 'nyitott',
    });
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

describe('feladatok SQLite-on: jogosultság', () => {
  it('admin mindent lát, tag csak a sajátját; más feladatát nem módosíthatja', async () => {
    const db = new DatabaseSync(':memory:');
    db.exec(`CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT, email TEXT, disabled INTEGER DEFAULT 0);
      INSERT INTO users VALUES (1,'Laci','l@x',0),(2,'Anna','a@x',0);
      CREATE TABLE change_log (id INTEGER PRIMARY KEY, ts INTEGER, user_id INTEGER, action TEXT, summary TEXT, leaf_ids TEXT, items TEXT, undo TEXT);`);
    const env = { DB: d1(db) } as any;
    const admin = { id: 1, role: 'admin' } as any;
    const anna = { id: 2, role: 'member' } as any;
    const post = (u: any, body: unknown, path = '/api/tasks', method = 'POST') =>
      handleTasks(env, new Request('https://x' + path, { method, body: JSON.stringify(body) }), path, u);
    const r1: any = await (await post(admin, {
      type: 'telefon',
      title: 'Kalmia hívása',
      partner_key: 'kalmia',
      assignee_id: 2,
      due_date: '2026-11-09',
      due_time: '10:00',
    }))!.json();
    await post(admin, { type: 'email', title: 'Saját levél', due_date: '2026-11-09' });
    expect((await loadTasks(env, admin)).tasks).toHaveLength(2);
    const mine = (await loadTasks(env, anna)).tasks;
    expect(mine.map((t) => t.title)).toEqual(['Kalmia hívása']);
    const other = (await loadTasks(env, admin)).tasks.find((t) => t.title === 'Saját levél')!;
    await expect(post(anna, { status: 'kesz' }, '/api/tasks/' + other.id, 'PUT')).rejects.toThrow(/nem módosíthatod/);
    await post(anna, { status: 'kesz' }, '/api/tasks/' + r1.id, 'PUT');
    const done = (await loadTasks(env, anna)).tasks[0];
    expect(done.status).toBe('kesz');
    expect(done.done_at).toBeGreaterThan(0);
  });
});
