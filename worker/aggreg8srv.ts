// Szerveroldali aggreg8-szinkron (a Mac nélkül): az aggreg8 standalone API-ját a szerver hívja.
// A Google-belépést (reCAPTCHA) a szerver nem tudja elvégezni: a felhasználó egyszer átadja a böngészőben lévő
// aggreg8-munkamenetet (könyvjelző a Bekötések alatt), a szerver ezt titkos táblában tárolja (a böngészőbe nem megy ki),
// és a lejárata előtt megújítja (/session-token/refresh). Ütemezve: banki frissítés indítása (ACTIVE_SYNC) a bankkapcsolatokra,
// várakozás, majd a tranzakciók és egyenlegek beolvasása a meglévő aggreg8-beolvasóval.
import { parseAggreg8Json } from '../shared/aggreg8';
import { collectAggreg8, consentIds, jwtExpMs, type A8Get } from '../shared/aggreg8export';
import { addDays } from '../shared/workdays';
import { requireRole, type User } from './auth';
import { ingestAggreg8Accounts, lastBankDates } from './ingest';
import { logChange } from './changelog';
import { Env, HttpError, getSetting, json, now, readJson, setSetting, todayHu } from './util';

const BACKEND = 'https://standalone-backend.aggreg8.hu';
const TASK_API = 'https://task-api.ftx-link.aggreg8.hu';
const STATUS = 'a8_server_status';

let ready: Promise<boolean> | null = null;
function ensureSecrets(env: Env): Promise<boolean> {
  if (!ready)
    ready = env.DB.prepare(
      'CREATE TABLE IF NOT EXISTS secrets (name VARCHAR(60) NOT NULL PRIMARY KEY, value TEXT NOT NULL, meta TEXT, updated_at BIGINT NOT NULL)',
    )
      .run()
      .then(() => true)
      .catch((e) => {
        ready = null;
        console.error('secrets ddl', e);
        return false;
      });
  return ready;
}

interface Session {
  token: string;
  userId: number;
  exp: number | null;
  /** utolsó megújítás / átadás ideje */
  at: number;
}

async function loadSession(env: Env): Promise<Session | null> {
  if (!(await ensureSecrets(env))) return null;
  const r = await env.DB.prepare("SELECT value, meta FROM secrets WHERE name = 'aggreg8_session'").first<{ value: string; meta: string | null }>();
  if (!r) return null;
  const meta = JSON.parse(r.meta || '{}');
  return { token: r.value, userId: Number(meta.userId) || 0, exp: jwtExpMs(r.value), at: Number(meta.at) || 0 };
}

async function saveSession(env: Env, token: string, userId: number) {
  await ensureSecrets(env);
  await env.DB.prepare(
    `INSERT INTO secrets (name, value, meta, updated_at) VALUES ('aggreg8_session', ?, ?, ?)
     ON CONFLICT(name) DO UPDATE SET value = excluded.value, meta = excluded.meta, updated_at = excluded.updated_at`,
  )
    .bind(token, JSON.stringify({ userId, at: now() }), now())
    .run();
}

async function clearSession(env: Env) {
  if (await ensureSecrets(env)) await env.DB.prepare("DELETE FROM secrets WHERE name = 'aggreg8_session'").run();
}

export interface A8Status {
  connected: boolean;
  exp: number | null;
  lastRun: number | null;
  ok: boolean | null;
  message: string;
  needsAction?: string | null;
  banks?: string[];
}

async function setStatus(env: Env, s: Partial<A8Status>) {
  const cur = JSON.parse((await getSetting(env, STATUS)) || '{}');
  await setSetting(env, STATUS, JSON.stringify({ ...cur, ...s }));
}

export async function a8Status(env: Env): Promise<A8Status> {
  const s = await loadSession(env).catch(() => null);
  const st = JSON.parse((await getSetting(env, STATUS)) || '{}');
  return {
    connected: !!s,
    exp: s?.exp ?? null,
    lastRun: st.lastRun ?? null,
    ok: st.ok ?? null,
    message: st.message || '',
    needsAction: st.needsAction || null,
    banks: st.banks || [],
  };
}

class A8AuthError extends Error {}

async function call(token: string, method: string, url: string, body?: unknown, timeoutMs = 60000): Promise<any> {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const r = await fetch(url, {
      method,
      signal: ac.signal,
      headers: {
        Authorization: 'Bearer ' + token,
        Accept: 'application/json',
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    if (r.status === 401 || r.status === 403) throw new A8AuthError('Az aggreg8-munkamenet lejárt vagy érvénytelen.');
    const text = await r.text();
    const data = text ? JSON.parse(text) : null;
    if (!r.ok) {
      const e: any = new Error(`aggreg8 ${r.status}: ${String((data && (data.message || data.error)) || text).slice(0, 160)}`);
      e.status = r.status;
      throw e;
    }
    return data;
  } finally {
    clearTimeout(t);
  }
}

/** a munkamenet megújítása: 6 óránként, vagy ha 2 napon belül lejárna (így ritka használat mellett is életben marad) */
async function refreshIfNeeded(env: Env, s: Session, force = false): Promise<Session> {
  if (!force && now() - s.at < 6 * 3600_000 && (!s.exp || s.exp - now() > 2 * 86400_000)) return s;
  const r = await call(s.token, 'POST', BACKEND + '/session-token/refresh', {});
  const tok = r && (r.sessionToken || r.token);
  if (!tok || typeof tok !== 'string') throw new Error('Az aggreg8 nem adott új munkamenetet.');
  await saveSession(env, tok, s.userId);
  return { token: tok, userId: s.userId, exp: jwtExpMs(tok), at: now() };
}

/** életben tartás (ütemezve, hétvégén is): csak megújít, ha kell */
export async function a8KeepAlive(env: Env): Promise<string> {
  const s = await loadSession(env);
  if (!s) return 'nincs munkamenet';
  try {
    const n = await refreshIfNeeded(env, s);
    return n.exp ? 'érvényes: ' + new Date(n.exp).toISOString() : 'megújítva';
  } catch (e: any) {
    if (e instanceof A8AuthError) {
      await clearSession(env);
      await setStatus(env, { ok: false, message: e.message, needsAction: 'Add át újra az aggreg8-belépést (Beállítások › Bekötések).' });
    }
    return 'hiba: ' + e.message;
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** banki frissítés a bankkapcsolatokra: indítás, majd várakozás a befejezésre (összesen legfeljebb ~2,5 perc) */
async function activeSync(token: string, consents: { id: string; bank: string }[]): Promise<{ bank: string; status: string }[]> {
  const started: { bank: string; taskId: string }[] = [];
  const out: { bank: string; status: string }[] = [];
  for (const c of consents) {
    try {
      const init = await call(token, 'POST', BACKEND + '/task/init', { flow: 'ACTIVE_SYNC', bankAccessConsentId: c.id });
      if (!init?.taskId) {
        out.push({ bank: c.bank, status: 'nem indult' });
        continue;
      }
      if (init.token) await call(init.token, 'POST', `${TASK_API}/task/${init.taskId}/start`, {}).catch(() => null);
      started.push({ bank: c.bank, taskId: String(init.taskId) });
    } catch (e: any) {
      if (e instanceof A8AuthError) throw e;
      out.push({ bank: c.bank, status: 'hiba: ' + String(e.message).slice(0, 80) });
    }
  }
  const deadline = now() + 150_000;
  const pending = new Map(started.map((s) => [s.taskId, s.bank]));
  while (pending.size && now() < deadline) {
    await sleep(6000);
    for (const [id, bank] of [...pending]) {
      const st = await call(token, 'GET', `${BACKEND}/task/${id}/state`).catch(() => null);
      const s = String((st && (st.status || st.state)) || '');
      const auth = JSON.stringify(st || {}).match(/REDIRECT_TO_BANK|WAITING_FOR_DECOUPLED_AUTH|SMS/);
      if (s === 'COMPLETED' || s === 'FAILED' || s === 'ERROR' || auth) {
        out.push({ bank, status: auth ? 'banki jóváhagyás kell' : s === 'COMPLETED' ? 'frissítve' : 'sikertelen' });
        pending.delete(id);
      }
    }
  }
  for (const bank of pending.values()) out.push({ bank, status: 'még fut (a következő körben jön)' });
  return out;
}

/** a teljes szerveroldali kör: megújítás, banki frissítés, letöltés, beolvasás */
export async function syncAggreg8Server(env: Env, opts: { activeSync?: boolean } = {}): Promise<unknown> {
  let s = await loadSession(env);
  if (!s) return { skipped: 'nincs aggreg8-munkamenet' };
  try {
    s = await refreshIfNeeded(env, s);
    const tok = s.token;
    const get: A8Get = async (p, soft) => {
      try {
        return await call(tok, 'GET', BACKEND + p);
      } catch (e: any) {
        if (soft && (e.status === 404 || e.status === 400)) return null;
        throw e;
      }
    };
    const consents = await consentIds(get);
    const synced = opts.activeSync === false || !consents.length ? [] : await activeSync(tok, consents);
    // a legrégebbi bank utolsó tétele előtt 7 nappal kezdve (a bankok visszamenőleg is könyvelnek; a duplikációt a beolvasó szűri)
    const dates = Object.values(await lastBankDates(env))
      .filter(Boolean)
      .sort();
    const since = dates.length ? addDays(dates[0], -7) : addDays(todayHu(), -60);
    const data = await collectAggreg8(get, since);
    const parsed = parseAggreg8Json({ balances: data.balances, transactions: data.transactions });
    const r = await ingestAggreg8Accounts(env, s.userId, parsed.accounts, parsed.balances, parsed.skipped, 'server');
    const needs = synced.some((x) => x.status === 'banki jóváhagyás kell')
      ? 'A bank jóváhagyást kér: nyisd meg az aggreg8-at, és frissítsd ott a bankkapcsolatot (90/180 naponta szükséges).'
      : null;
    const msg = `${data.transactions.length} tétel (${since} óta)` + (synced.length ? ' · ' + synced.map((x) => `${x.bank}: ${x.status}`).join(', ') : '');
    await setStatus(env, { lastRun: now(), ok: true, message: msg, needsAction: needs, banks: consents.map((c) => c.bank) });
    return { ok: true, since, transactions: data.transactions.length, banks: synced, accounts: r.accounts };
  } catch (e: any) {
    const auth = e instanceof A8AuthError;
    if (auth) await clearSession(env);
    await setStatus(env, {
      lastRun: now(),
      ok: false,
      message: String(e.message).slice(0, 200),
      needsAction: auth ? 'Add át újra az aggreg8-belépést (Beállítások › Bekötések).' : null,
    });
    return { ok: false, error: e.message };
  }
}

export async function handleAggreg8Server(env: Env, req: Request, path: string, u: User): Promise<Response | null> {
  if (!path.startsWith('/api/aggreg8/')) return null;
  requireRole(u, 'admin');
  if (path === '/api/aggreg8/session' && req.method === 'POST') {
    const b = await readJson(req);
    const token = String(b.token || '').trim();
    if (!/^[\w-]+\.[\w-]+\.[\w-]+$/.test(token) || token.length > 4000)
      throw new HttpError(400, 'Ez nem aggreg8-munkamenet (jelentkezz be az aggreg8-ba, és onnan indítsd a könyvjelzőt).');
    // ellenőrzés: érvényes-e (a felhasználó adatai lekérhetők)
    try {
      await call(token, 'GET', BACKEND + '/user');
    } catch (e: any) {
      throw new HttpError(
        400,
        e instanceof A8AuthError ? 'Az aggreg8-munkamenet nem érvényes – jelentkezz be újra az aggreg8-ba.' : 'Az aggreg8 nem érhető el: ' + e.message,
      );
    }
    await saveSession(env, token, u.id);
    await setStatus(env, { ok: null, message: 'Munkamenet átadva', needsAction: null });
    await logChange(env, u.id, 'aggreg8_session', 'aggreg8: szerveroldali kapcsolat beállítva', [], null);
    return json({ ok: true, status: await a8Status(env) });
  }
  if (path === '/api/aggreg8/session' && req.method === 'DELETE') {
    await clearSession(env);
    await setStatus(env, { ok: null, message: 'Leválasztva', needsAction: null });
    await logChange(env, u.id, 'aggreg8_session', 'aggreg8: szerveroldali kapcsolat törölve', [], null);
    return json({ ok: true });
  }
  if (path === '/api/aggreg8/status' && req.method === 'GET') return json(await a8Status(env));
  if (path === '/api/aggreg8/sync' && req.method === 'POST') return json(await syncAggreg8Server(env));
  return null;
}
