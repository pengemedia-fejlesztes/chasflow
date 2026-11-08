// Közös teszt-segéd: a VALÓDI backend (src/server/app) egy memóriabeli SQLite-adatbázison,
// ugyanazzal az adatbázis-réteggel (src/server/runtime/d1-sqlite.mjs) és migrációkkal, mint élesben/lokálisan.
//
//   const t = await createTestApp();                 // admin felhasználó, bejelentkezve
//   const r = await t.post('/api/...', { ... });     // { status, data }
//   t.sql.prepare('SELECT ...').all();               // közvetlen ellenőrzés az adatbázisban
//   await t.scheduled(Date.parse('2026-11-09T04:02:00Z'));  // ütemezett futás (cron)
//
// Külső szolgáltatások (Billingo, NAV, Enable Banking, e-mail) hívásait a tesztben kell kiváltani
// (vi.stubGlobal('fetch', ...)), vagy a megfelelő *_API_URL env-vel egy mock címre irányítani.
import { DatabaseSync } from 'node:sqlite';
import app from '../../src/server/app/index';
import { newPasswordFields } from '../../src/server/app/auth';
import type { Env } from '../../src/server/app/util';
import { FULL_ACCESS, type Access } from '../../src/shared/access';
import { SqliteD1, migrate } from '../../src/server/runtime/d1-sqlite.mjs';

export type Role = 'admin' | 'member' | 'viewer'; // az adatbazis CHECK-je szerint (member = szerkeszto)
export interface CallResult<T = any> {
  status: number;
  data: T;
  headers: Headers;
}

const ORIGIN = 'https://cashflow.test';
const PASSWORD = 'Teszt-jelszo-12345';

export async function createTestApp(opts: { role?: Role; env?: Partial<Env>; login?: boolean } = {}) {
  const sql = new DatabaseSync(':memory:');
  sql.exec('PRAGMA foreign_keys = ON');
  migrate(sql, 'migrations');
  const db = new SqliteD1(sql);
  const pending: Promise<unknown>[] = [];
  const ctx = { waitUntil: (p: Promise<unknown>) => void pending.push(p) };
  const env = {
    DB: db,
    ASSETS: { fetch: async () => new Response('<!doctype html><title>asset</title>', { headers: { 'Content-Type': 'text/html' } }) },
    ...opts.env,
  } as Env;

  let cookie = '';
  async function call<T = any>(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<CallResult<T>> {
    const isForm = typeof FormData !== 'undefined' && body instanceof FormData;
    const req = new Request(ORIGIN + path, {
      method,
      headers: {
        Origin: ORIGIN,
        'X-Requested-With': 'cashflow',
        ...(body !== undefined && !isForm && typeof body !== 'string' ? { 'Content-Type': 'application/json' } : {}),
        ...(cookie ? { Cookie: cookie } : {}),
        ...headers,
      },
      body: body === undefined ? undefined : isForm || typeof body === 'string' ? (body as any) : JSON.stringify(body),
    });
    const res = await app.fetch(req, env);
    const text = await res.text();
    let data: any = text;
    try {
      data = JSON.parse(text);
    } catch {}
    return { status: res.status, data, headers: res.headers };
  }

  /**
   * Felhasználó felvétele. A nem admin felhasználó alapból TELJES menü- és adathozzáférést kap (user_access), mert
   * ezek a tesztek a szerepkört (szerkesztő / olvasó) vizsgálják. access: null = nincs megadva, ami a szerveren tiltást
   * jelent; a felhasználónkénti hozzáférés-kezelést a security-boundaries / access tesztek fedik.
   */
  async function addUser(email: string, role: Role, password = PASSWORD, access: Access | null = FULL_ACCESS) {
    const f = await newPasswordFields(password);
    const r = sql
      .prepare('INSERT INTO users (email, name, role, pw_hash, pw_salt, pw_iter, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(email, email.split('@')[0], role, f.pw_hash, f.pw_salt, f.pw_iter, Date.now());
    const id = Number(r.lastInsertRowid);
    if (role !== 'admin' && access) {
      const row = sql.prepare("SELECT value FROM settings WHERE key = 'user_access'").get() as { value: string } | undefined;
      const all = { ...(row ? JSON.parse(row.value) : {}), [id]: access };
      sql.prepare("INSERT INTO settings (key, value) VALUES ('user_access', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(JSON.stringify(all));
    }
    return id;
  }

  async function loginAs(email: string, password = PASSWORD) {
    cookie = '';
    const r = await call('POST', '/api/auth/login', { email, password });
    if (r.status !== 200) throw new Error(`login failed: ${r.status} ${JSON.stringify(r.data)}`);
    const set = r.headers.get('Set-Cookie') || '';
    cookie = set.split(';')[0];
    return r;
  }

  const userId = await addUser('admin@teszt.hu', opts.role || 'admin');
  if (opts.login !== false) await loginAs('admin@teszt.hu');

  return {
    sql,
    db,
    env,
    userId,
    call,
    get: <T = any>(p: string) => call<T>('GET', p),
    post: <T = any>(p: string, b?: unknown) => call<T>('POST', p, b ?? {}),
    put: <T = any>(p: string, b?: unknown) => call<T>('PUT', p, b ?? {}),
    patch: <T = any>(p: string, b?: unknown) => call<T>('PATCH', p, b ?? {}),
    del: <T = any>(p: string, b?: unknown) => call<T>('DELETE', p, b),
    addUser,
    loginAs,
    logout: () => void (cookie = ''),
    /** Ütemezett futás (cron); megvárja a háttérmunkákat is. */
    async scheduled(at: number) {
      await app.scheduled({ scheduledTime: at, cron: 'test' }, env, ctx);
      await this.settle();
    },
    /** A waitUntil-lel indított háttérmunkák bevárása. */
    async settle() {
      while (pending.length) await Promise.allSettled(pending.splice(0));
    },
    close: () => sql.close(),
  };
}
export type TestApp = Awaited<ReturnType<typeof createTestApp>>;
