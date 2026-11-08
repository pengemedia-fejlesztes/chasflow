import { DatabaseSync } from 'node:sqlite';
import { readdirSync, readFileSync } from 'node:fs';
import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { handleData, loadBundle } from '../../src/server/app/data';
import { bundlePatch, parseSections } from '../../src/shared/data-sections';
import { visibleBundle } from '../../src/server/app/visibility';
import { FULL_ACCESS, NO_ACCESS } from '../../src/shared/access';
import { buildIndex } from '../../src/shared/model';
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
afterAll(() => {
  for (const db of databases.splice(0)) db.close();
});

let env: any, sql: DatabaseSync;
const user = { id: 1, role: 'admin', name: 'Test', email: 'test@example.test' } as any;
let full: Awaited<ReturnType<typeof loadBundle>>;
beforeAll(async () => {
  ({ env, sql } = fixture());
  sql.exec(
    "INSERT INTO users(id,email,name,role,pw_hash,pw_salt,pw_iter,created_at) VALUES (1,'test@example.test','Test','admin','x','x',100000,0); INSERT INTO settings(key,value) VALUES ('catalog_seeded','1')",
  );
  const insert = sql.prepare(
    "INSERT INTO entries(id,kind,date,leaf_id,name,amount,done,tentative,source,updated_at) VALUES (?,'actual',?,'l','Historical entry',100,0,0,'manual',1)",
  );
  sql.exec('BEGIN');
  for (let i = 0; i < 10000; i++) insert.run('entry-' + i, `202${i % 7}-01-15`);
  sql.exec('COMMIT');
  full = await loadBundle(env, user);
});

describe('scoped data reads with 10,000 historical ledger rows', () => {
  it('does not query or transfer financial history for a stock refresh', async () => {
    const queries: string[] = [];
    const original = env.DB.prepare;
    env.DB.prepare = (q: string) => {
      queries.push(q);
      return original(q);
    };
    try {
      const response = await handleData(env, new Request('https://example.test/api/data?sections=stock'), '/api/data', user);
      const patch = (await response!.json()) as any;
      expect(patch.sections).toEqual(['stock']);
      expect(patch).not.toHaveProperty('entries');
      expect(patch).not.toHaveProperty('settings');
      expect(patch).not.toHaveProperty('worktime');
      expect(queries.some((q) => /\b(?:entries|bank_tx|billingo_docs|worktime)\b/i.test(q))).toBe(false);
      expect(response!.headers.get('Server-Timing')).toMatch(/^data;dur=\d/);
      const fullBytes = Buffer.byteLength(JSON.stringify(full));
      const patchBytes = Buffer.byteLength(JSON.stringify(patch));
      expect(patchBytes).toBeLessThan(fullBytes / 100);
      console.info(
        'Synthetic benchmark:',
        JSON.stringify({ historyRows: full.entries.length, fullBytes, stockPatchBytes: patchBytes, stockQueries: queries.length }),
      );
      // Merging this refresh must leave every financial calculation exactly unchanged.
      const { sections, ...fields } = patch;
      const { sectionOf: beforeSection, ...before } = buildIndex(full);
      const { sectionOf: afterSection, ...after } = buildIndex({ ...full, ...fields });
      expect(after).toEqual(before);
      expect(afterSection('l')).toBe(beforeSection('l'));
    } finally {
      env.DB.prepare = original;
    }
  });
  it('only transfers task data for a task refresh', async () => {
    const patch = bundlePatch(await loadBundle(env, user, ['tasks']), ['tasks']);
    expect(patch.tasks).toEqual([]);
    expect(patch.taskUsers).toHaveLength(1);
    expect(patch).not.toHaveProperty('entries');
    expect(patch).not.toHaveProperty('stockMoves');
  });
  it('applies the existing permission filter before selecting response sections', () => {
    for (const section of ['ledger', 'catalog', 'tasks', 'stock', 'payroll'] as const) {
      const filtered = bundlePatch(visibleBundle({ ...full, me: { ...full.me, role: 'member' } }, NO_ACCESS), [section]);
      expect(JSON.stringify(filtered)).not.toContain('Historical entry');
      expect(filtered.myAccess?.menus).toEqual([]);
    }
    expect(bundlePatch(visibleBundle(full, FULL_ACCESS), ['ledger']).entries).toHaveLength(10000);
  });
  it('validates scopes and rejects unknown or empty selectors', async () => {
    expect(parseSections(null)).toBeNull();
    expect(parseSections('stock,tasks,stock')).toEqual(['stock', 'tasks']);
    for (const invalid of ['', 'settings', '__proto__', 'ledger,', 'constructor']) {
      await expect(handleData(env, new Request('https://example.test/api/data?sections=' + invalid), '/api/data', user)).rejects.toMatchObject({ status: 400 });
    }
  });
});
