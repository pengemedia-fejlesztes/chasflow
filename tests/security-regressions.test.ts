import { DatabaseSync } from 'node:sqlite';
import { readdirSync, readFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { applyBatch, handleData } from '../worker/data';
import { handleChangelog } from '../worker/changelog';
import { handleAuth, handleUsers, newPasswordFields } from '../worker/auth';
import { handleIngest } from '../worker/ingest';
import { sha256 } from '../worker/util';
import { parseWholeForint } from '../shared/amount';
import type { Entry } from '../shared/types';

const databases: DatabaseSync[] = [];
function fixture() {
  const sql = new DatabaseSync(':memory:');
  databases.push(sql);
  for (const name of readdirSync('migrations')
    .filter((n) => n.endsWith('.sql'))
    .sort())
    sql.exec(readFileSync(`migrations/${name}`, 'utf8'));
  class Statement {
    args: any[] = [];
    constructor(readonly query: string) {}
    bind(...args: any[]) {
      this.args = args;
      return this;
    }
    async first() {
      return sql.prepare(this.query).get(...this.args) || null;
    }
    async all() {
      return { results: sql.prepare(this.query).all(...this.args) };
    }
    async run() {
      const r = sql.prepare(this.query).run(...this.args);
      return { meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid) } };
    }
  }
  const env = {
    DB: {
      prepare: (q: string) => new Statement(q),
      batch: async (stmts: Statement[]) => {
        sql.exec('BEGIN');
        try {
          const out = stmts.map((s) => {
            const statement = sql.prepare(s.query);
            if (statement.columns().length) return { results: statement.all(...s.args) };
            const result = statement.run(...s.args);
            return { results: [], meta: { changes: Number(result.changes) } };
          });
          sql.exec('COMMIT');
          return out;
        } catch (e) {
          sql.exec('ROLLBACK');
          throw e;
        }
      },
    },
  } as any;
  sql.exec(
    "INSERT INTO groups(id, section, label, sort) VALUES ('g','in','Test',0); INSERT INTO leaves(id,group_id,label,sort,archived) VALUES ('l','g','Test',0,0)",
  );
  return { sql, env };
}
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
});
const entry = (id: string): Entry => ({
  id,
  kind: 'plan',
  date: '2026-10-30',
  leaf_id: 'l',
  name: 'Test',
  amount: 1250,
  series_id: null,
  done: 0,
  tentative: 0,
  source: 'manual',
  ext_ref: null,
  link_id: null,
  note: null,
});
function addUser(sql: DatabaseSync, role = 'admin') {
  sql.prepare("INSERT INTO users (id,email,name,role,pw_hash,pw_salt,pw_iter,created_at) VALUES (1,'a@example.test','A',?,'x','eA',100000,0)").run(role);
}

describe('whole HUF inputs', () => {
  it('accepts whole amounts and grouping, rejects decimals without magnifying them', () => {
    for (const v of ['1250', '1 250', '1\u00a0250', '1\u202f250']) expect(parseWholeForint(v)).toBe(1250);
    for (const v of ['1250,50', '1250.50', '-1250', '1e3', '1 25', 'Infinity', '1000000000001', '']) expect(parseWholeForint(v)).toBeNull();
  });
});

describe('atomic mutation preconditions using real SQLite', () => {
  it('rejects stale edits/deletes and rolls back related new rows and series', async () => {
    const { env, sql } = fixture();
    const first = await applyBatch(env, { upsert: [entry('e')], expected: { e: null } }, 1);
    const version = first.versions.e;
    const saved = await applyBatch(env, { upsert: [{ ...entry('e'), amount: 2000 }], expected: { e: version } }, 1);
    expect(saved.versions.e).toBeGreaterThan(version);
    const series = { id: 's', leaf_id: 'l', name: 'New', rep: 'monthly' as const, day: 1 };
    await expect(
      applyBatch(env, { upsert: [entry('new'), entry('e')], expected: { new: null, e: version }, series: [series], expectedSeries: { s: null } }, 1),
    ).rejects.toMatchObject({ status: 409 });
    expect(sql.prepare("SELECT amount FROM entries WHERE id='e'").get()).toMatchObject({ amount: 2000 });
    expect(sql.prepare("SELECT * FROM entries WHERE id='new'").get()).toBeUndefined();
    expect(sql.prepare("SELECT * FROM series WHERE id='s'").get()).toBeUndefined();
    await expect(applyBatch(env, { delete: ['e'], expected: { e: version } }, 1)).rejects.toMatchObject({ status: 409 });
    expect(sql.prepare('SELECT COUNT(*) AS n FROM mutation_guard').get()).toMatchObject({ n: 0 });
  });
  it('requires explicit versions and prevents stale undo/new ID collision and stale series updates', async () => {
    const { env, sql } = fixture();
    await applyBatch(env, { upsert: [entry('e')], expected: { e: null } }, 1);
    await expect(applyBatch(env, { upsert: [entry('e')] }, 1)).rejects.toMatchObject({ status: 409 });
    await expect(applyBatch(env, { upsert: [entry('e')], expected: { e: null } }, 1)).rejects.toMatchObject({ status: 409 });
    sql.exec("INSERT INTO series VALUES ('s','l','Changed','monthly',10)");
    await expect(
      applyBatch(
        env,
        { series: [{ id: 's', leaf_id: 'l', name: 'Old', rep: 'monthly', day: 10 }], expectedSeries: { s: JSON.stringify(['l', 'Old', 'monthly', 10]) } },
        1,
      ),
    ).rejects.toMatchObject({ status: 409 });
  });
});

describe('history undo', () => {
  it('refuses to overwrite a newer edit even immediately after the original save', async () => {
    const { env, sql } = fixture();
    addUser(sql);
    const u = { id: 1, role: 'admin' } as any;
    const request = (body: unknown) => new Request('https://x/api/entries/batch', { method: 'POST', body: JSON.stringify(body) });
    const response = await handleData(env, request({ upsert: [entry('e')], expected: { e: null } }), '/api/entries/batch', u);
    const saved = (await response!.json()) as any;
    const log = sql.prepare('SELECT id FROM change_log ORDER BY id LIMIT 1').get()!;
    await applyBatch(env, { upsert: [{ ...entry('e'), amount: 3000 }], expected: { e: saved.versions.e } }, 1);
    const path = `/api/changelog/${log.id}/undo`;
    await expect(handleChangelog(env, request({}), path, u)).rejects.toMatchObject({ status: 409 });
    expect(sql.prepare("SELECT amount FROM entries WHERE id='e'").get()).toMatchObject({ amount: 3000 });
    expect(sql.prepare('SELECT undone_at FROM change_log WHERE id=?').get(log.id)).toMatchObject({ undone_at: null });
  });
});

describe('upload key lifecycle', () => {
  it.each(['member', 'viewer', 'disabled', 'deleted'])('rejects a valid key owned by %s', async (state) => {
    const { env, sql } = fixture();
    addUser(sql);
    sql.prepare("INSERT INTO settings VALUES ('import_token',?)").run(JSON.stringify({ hash: await sha256('key'), user_id: 1 }));
    if (state === 'deleted') sql.exec('DELETE FROM users');
    else if (state === 'disabled') sql.exec('UPDATE users SET disabled=1');
    else sql.prepare('UPDATE users SET role=?').run(state);
    await expect(
      handleIngest(env, new Request('https://x/api/ingest/request', { method: 'POST', headers: { Authorization: 'Bearer key' } }), '/api/ingest/request'),
    ).rejects.toMatchObject({ status: 401 });
  });
  it('revokes on demotion so re-promotion cannot resurrect the key', async () => {
    const { env, sql } = fixture();
    addUser(sql);
    sql.prepare("INSERT INTO settings VALUES ('import_token',?)").run(JSON.stringify({ hash: await sha256('key'), user_id: 1 }));
    const admin = { id: 2, role: 'admin' } as any;
    await handleUsers(env, new Request('https://x/api/users/1', { method: 'PATCH', body: JSON.stringify({ role: 'member' }) }), '/api/users/1', admin);
    sql.exec("UPDATE users SET role='admin'");
    expect(sql.prepare("SELECT * FROM settings WHERE key='import_token'").get()).toBeUndefined();
  });
});

describe('concurrent login attempts', () => {
  it('counts all concurrent failures and locks the user after the threshold', async () => {
    const { env, sql } = fixture();
    addUser(sql);
    const pw = await newPasswordFields('correct-password');
    sql.prepare('UPDATE users SET pw_hash=?,pw_salt=?,pw_iter=?').run(pw.pw_hash, pw.pw_salt, pw.pw_iter);
    const outcomes = await Promise.allSettled(
      Array.from({ length: 8 }, (_, i) =>
        handleAuth(
          env,
          new Request('https://x/api/auth/login', {
            method: 'POST',
            headers: { 'CF-Connecting-IP': `192.0.2.${i}` },
            body: JSON.stringify({ email: 'a@example.test', password: 'wrong' }),
          }),
          '/api/auth/login',
        ),
      ),
    );
    expect(outcomes.every((r) => r.status === 'rejected')).toBe(true);
    const user = sql.prepare('SELECT failed_logins,locked_until FROM users').get()!;
    expect(Number(user.failed_logins)).toBeGreaterThanOrEqual(5);
    expect(Number(user.locked_until)).toBeGreaterThan(Date.now());
  });
  it('reserves no more than 20 attempts from one IP under concurrency', async () => {
    const { env, sql } = fixture();
    await Promise.allSettled(
      Array.from({ length: 25 }, () =>
        handleAuth(
          env,
          new Request('https://x/api/auth/login', { method: 'POST', headers: { 'CF-Connecting-IP': '192.0.2.1' }, body: '{}' }),
          '/api/auth/login',
        ),
      ),
    );
    expect(sql.prepare('SELECT COUNT(*) AS n FROM login_attempts').get()).toMatchObject({ n: 20 });
  });
});

describe('pending historical migration with existing production categories', () => {
  it.each([true, false])('installs schema safely when destination label conflicts=%s', (conflict) => {
    const sql = new DatabaseSync(':memory:');
    databases.push(sql);
    for (const name of readdirSync('migrations')
      .filter((n) => n.endsWith('.sql') && n < '0024')
      .sort())
      sql.exec(readFileSync(`migrations/${name}`, 'utf8'));
    sql.exec("INSERT INTO groups(id,section,label,sort) VALUES ('source','in','Source',0), ('dest','in','Destination',0)");
    sql
      .prepare("INSERT INTO leaves (id,group_id,label,sort,archived) VALUES ('l_de00a4a5','source','Orvosmost',0,0),('l_0008ee2f','dest',?,0,0)")
      .run(conflict ? 'Orvosmost' : 'UrgentCare');
    sql.exec("INSERT INTO partner_rules (pattern,leaf_id,hits,updated_at) VALUES ('test','l_0008ee2f',0,0)");
    sql.exec(readFileSync('migrations/0024_change_log.sql', 'utf8'));
    sql.exec(readFileSync('migrations/0025_mutation_guard.sql', 'utf8'));
    expect(sql.prepare("SELECT group_id FROM leaves WHERE id='l_de00a4a5'").get()).toMatchObject({ group_id: conflict ? 'source' : 'dest' });
    expect(sql.prepare("SELECT archived FROM leaves WHERE id='l_0008ee2f'").get()).toMatchObject({ archived: conflict ? 0 : 1 });
    expect(sql.prepare("SELECT leaf_id FROM partner_rules WHERE pattern='test'").get()).toMatchObject({ leaf_id: conflict ? 'l_0008ee2f' : 'l_de00a4a5' });
    expect(sql.prepare('SELECT COUNT(*) AS n FROM change_log').get()).toMatchObject({ n: conflict ? 0 : 1 });
    expect(sql.prepare('SELECT COUNT(*) AS n FROM mutation_guard').get()).toMatchObject({ n: 0 });
  });
});
