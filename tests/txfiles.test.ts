import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { handleTxFiles } from '../worker/txfiles';

function d1(db: DatabaseSync) {
  const stmt = (sql: string, args: unknown[] = []) => ({
    bind: (...a: unknown[]) => stmt(sql, a),
    all: async () => ({ results: db.prepare(sql).all(...(args as any[])) }),
    first: async () => db.prepare(sql).get(...(args as any[])) ?? null,
    run: async () => (db.prepare(sql).run(...(args as any[])), { success: true }),
  });
  return { prepare: (sql: string) => stmt(sql), batch: async (ss: any[]) => Promise.all(ss.map((s) => s.all())) };
}

describe('tételhez feltöltött számla', () => {
  it('feltöltés, letöltés, típus- és méretellenőrzés, törlés', async () => {
    process.env.UPLOAD_DIR = mkdtempSync(join(tmpdir(), 'cf-up-'));
    const db = new DatabaseSync(':memory:');
    db.exec(`CREATE TABLE change_log (id INTEGER PRIMARY KEY, ts INTEGER, user_id INTEGER, action TEXT, summary TEXT, leaf_ids TEXT, items TEXT, undo TEXT);
      CREATE TABLE bank_tx (id TEXT PRIMARY KEY, date TEXT, amount INTEGER, partner TEXT);
      INSERT INTO bank_tx VALUES ('t1', '2026-11-04', -8255, 'Rackforest');`);
    const env = { DB: d1(db) } as any;
    const u = { id: 1, role: 'admin' } as any;
    const call = (path: string, method: string, body?: unknown) =>
      handleTxFiles(env, new Request('https://x' + path, { method, body: body ? JSON.stringify(body) : undefined }), path, u);
    const pdf = Buffer.from('%PDF-1.4 teszt').toString('base64');
    const r: any = await (await call('/api/bank/tx/t1/file', 'POST', { name: 'szamla.pdf', mime: 'application/pdf', data: pdf }))!.json();
    const got = await call('/api/bank/file/' + r.id, 'GET');
    expect(got!.headers.get('Content-Type')).toBe('application/pdf');
    expect(Buffer.from(await got!.arrayBuffer()).toString()).toBe('%PDF-1.4 teszt');
    await expect(call('/api/bank/tx/t1/file', 'POST', { name: 'x.exe', mime: 'application/x-msdownload', data: pdf })).rejects.toThrow(/PDF/);
    await expect(call('/api/bank/tx/nincs/file', 'POST', { name: 'a.pdf', mime: 'application/pdf', data: pdf })).rejects.toThrow(/Nincs ilyen tétel/);
    await call('/api/bank/file/' + r.id, 'DELETE');
    await expect(call('/api/bank/file/' + r.id, 'GET')).rejects.toThrow(/Nincs ilyen fájl/);
  });
});
