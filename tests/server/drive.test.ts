import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { handleDrive } from '../../src/server/app/drive';
import { handleTxFiles } from '../../src/server/app/txfiles';

function d1(db: DatabaseSync) {
  const stmt = (sql: string, args: unknown[] = []) => ({
    bind: (...a: unknown[]) => stmt(sql, a),
    all: async () => ({ results: db.prepare(sql).all(...(args as any[])) }),
    first: async () => db.prepare(sql).get(...(args as any[])) ?? null,
    run: async () => (db.prepare(sql).run(...(args as any[])), { success: true }),
  });
  return { prepare: (sql: string) => stmt(sql), batch: async (ss: any[]) => Promise.all(ss.map((s) => s.all())) };
}
afterEach(() => vi.restoreAllMocks());

describe('Google Drive mentés', () => {
  it('beállítás után a feltöltött számla a kiválasztott mappába kerül', async () => {
    process.env.UPLOAD_DIR = mkdtempSync(join(tmpdir(), 'cf-dr-'));
    const db = new DatabaseSync(':memory:');
    db.exec(`CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT);
      CREATE TABLE change_log (id INTEGER PRIMARY KEY, ts INTEGER, user_id INTEGER, action TEXT, summary TEXT, leaf_ids TEXT, items TEXT, undo TEXT);
      CREATE TABLE bank_tx (id TEXT PRIMARY KEY, date TEXT, amount INTEGER, partner TEXT);
      INSERT INTO bank_tx VALUES ('t1', '2026-11-04', -8255, 'Rackforest');`);
    const env = { DB: d1(db) } as any;
    const u = { id: 1, role: 'admin' } as any;
    const g = (path: string, method: string, body?: unknown) =>
      handleDrive(env, new Request('https://x' + path, { method, body: body ? JSON.stringify(body) : undefined }), path, u);
    await g('/api/google/client', 'PUT', { client_id: 'abc.apps.googleusercontent.com', client_secret: 'titkos-kulcs-123' });
    db.exec(
      `INSERT INTO secrets (name, value, meta, updated_at) VALUES ('google_token', '{"refresh_token":"r","access_token":"a","expires_at":9999999999999,"email":"x@y.hu"}', NULL, 1)`,
    );
    await g('/api/google/folder', 'PUT', { id: 'FOLDER_ID_12345', name: 'Számlák' });
    const calls: { url: string; body: string }[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url: any, init: any) => {
      calls.push({ url: String(url), body: new TextDecoder().decode(init.body) });
      return new Response(JSON.stringify({ id: 'DRIVE1', webViewLink: 'https://drive/1' }), { status: 200 });
    });
    const pdf = Buffer.from('%PDF-1.4').toString('base64');
    await handleTxFiles(
      env,
      new Request('https://x/api/bank/tx/t1/file', { method: 'POST', body: JSON.stringify({ name: 'a.pdf', mime: 'application/pdf', data: pdf }) }),
      '/api/bank/tx/t1/file',
      u,
    );
    expect(calls[0].url).toMatch(/upload\/drive\/v3\/files/);
    expect(calls[0].body).toContain('"parents":["FOLDER_ID_12345"]');
    expect(calls[0].body).toContain('2026-11-04 – Rackforest – -8255 Ft – a.pdf');
    const row = db.prepare('SELECT drive_id, drive_link FROM tx_files').get() as any;
    expect(row).toEqual({ drive_id: 'DRIVE1', drive_link: 'https://drive/1' });
    const st: any = await (await g('/api/google/status', 'GET'))!.json();
    expect(st).toMatchObject({ clientSet: true, email: 'x@y.hu', folder: { id: 'FOLDER_ID_12345' } });
    expect(JSON.stringify(st)).not.toContain('titkos');
  });
});
