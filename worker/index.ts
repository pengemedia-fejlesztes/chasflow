// Cashflow tervező – Cloudflare Worker belépési pont (API + ütemezett szinkron).
import { currentUser, handleAccount, handleAuth, handleUsers } from './auth';
import { handleBank, reapplyRules, syncAll } from './bank';
import { handleRules } from './rules';
import { handleData } from './data';
import { Env, HttpError, json, withSecurityHeaders } from './util';

async function route(req: Request, env: Env): Promise<Response> {
  const url = new URL(req.url);
  const path = url.pathname.replace(/\/+$/, '') || '/';

  if (!path.startsWith('/api/')) return env.ASSETS.fetch(req);

  // CSRF védelem: minden módosító kérésnek a saját felületünkről kell jönnie
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    const origin = req.headers.get('Origin');
    if (origin && origin !== url.origin) throw new HttpError(403, 'Tiltott eredet.');
    if (req.headers.get('X-Requested-With') !== 'cashflow') throw new HttpError(403, 'Hiányzó kliens fejléc.');
  }

  const auth = await handleAuth(env, req, path);
  if (auth) return auth;

  const u = await currentUser(env, req);
  if (!u) {
    if (path === '/api/bank/callback') return Response.redirect(`${url.origin}/?bank=error&msg=${encodeURIComponent('Jelentkezz be újra.')}`, 302);
    throw new HttpError(401, 'Bejelentkezés szükséges.');
  }

  const acc = await handleAccount(env, req, path, u);
  if (acc) return acc;
  if (u.must_change_pw) throw new HttpError(403, 'Először változtasd meg az ideiglenes jelszavadat.');

  for (const h of [handleUsers, handleData]) {
    const r = await h(env, req, path, u);
    if (r) return r;
  }
  const rr = await handleRules(env, req, path, u, () => reapplyRules(env));
  if (rr) return rr;
  const b = await handleBank(env, req, path, u, url);
  if (b) return b;
  throw new HttpError(404, 'Nincs ilyen végpont.');
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    try {
      return withSecurityHeaders(await route(req, env));
    } catch (e: any) {
      if (e instanceof HttpError) return withSecurityHeaders(json({ error: e.message }, e.status));
      console.error(e);
      return withSecurityHeaders(json({ error: 'Szerverhiba: ' + (e?.message || 'ismeretlen') }, 500));
    }
  },

  async scheduled(_ev: ScheduledController, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(
      syncAll(env).then(
        (r) => console.log('sync', JSON.stringify(r)),
        (e) => console.error('sync failed', e),
      ),
    );
  },
} satisfies ExportedHandler<Env>;
