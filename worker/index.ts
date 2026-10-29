// Cashflow tervező – Cloudflare Worker belépési pont (API + ütemezett szinkron).
import { currentUser, handleAccount, handleAuth, handleUsers } from './auth';
import { handleBank, payBillingoFromBank, reapplyRules, syncAll } from './bank';
import { autoPayBillingo } from './billingo';
import * as eb from './enablebanking';
import { handleRules } from './rules';
import { navEnabled, syncNav } from './nav';
import { handleIngest, handleIngestToken } from './ingest';
import { handlePartners } from './partners';
import { notifyUnplanned } from './notify';
import { refreshMonthStats } from './stats';
import { handleData } from './data';
import { handleChangelog } from './changelog';
import { Env, HttpError, getSetting, json, safeEqual, withSecurityHeaders } from './util';
import { SYNC_HOURS } from '../shared/aggreg8';

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

  // diagnosztika: teljes szinkron (Billingo, NAV, adószámok, párosítás) – csak darabszámokat ad vissza
  if (path === '/api/diag/sync' && req.method === 'POST') {
    const t = req.headers.get('X-Diag-Token') || '';
    if (!env.DIAG_TOKEN || env.DIAG_TOKEN.length < 32 || !safeEqual(t, env.DIAG_TOKEN)) throw new HttpError(404, 'Nincs ilyen végpont.');
    return json(await syncAll(env));
  }
  // diagnosztika: Billingo automatikus „fizetve” – próba (dry) vagy éles futtatás
  if (path === '/api/diag/autopay' && req.method === 'POST') {
    const t = req.headers.get('X-Diag-Token') || '';
    if (!env.DIAG_TOKEN || env.DIAG_TOKEN.length < 32 || !safeEqual(t, env.DIAG_TOKEN)) throw new HttpError(404, 'Nincs ilyen végpont.');
    const dry = url.searchParams.get('run') !== '1';
    return json(dry ? await autoPayBillingo(env, { dry }) : await payBillingoFromBank(env));
  }
  // diagnosztika (GitHub Actions): egyszer használatos, véletlen DIAG_TOKEN-nel – a NAV szinkron lefuttatása, csak állapotot ad vissza
  if (path === '/api/diag/nav' && req.method === 'POST') {
    const t = req.headers.get('X-Diag-Token') || '';
    if (!env.DIAG_TOKEN || env.DIAG_TOKEN.length < 32 || !safeEqual(t, env.DIAG_TOKEN)) throw new HttpError(404, 'Nincs ilyen végpont.');
    // Enable Banking: hitelesítés + elérhető magyar bankok (csak nevek)
    let bank: unknown = 'nincs beállítva';
    if (env.EB_APP_ID && env.EB_PRIVATE_KEY) {
      try {
        const names = (await eb.listAspsps(env)).map((a) => a.name);
        bank = { ok: true, banks: names.length, names };
      } catch (e: any) {
        bank = { ok: false, error: String(e?.message || e).slice(0, 300) };
      }
    }
    if (!navEnabled(env)) return json({ ok: false, error: 'NAV nincs beállítva', bank });
    try {
      const r = await syncNav(env);
      return json({ ok: true, ...r, bank });
    } catch (e: any) {
      return json({ ok: false, error: String(e?.message || e).slice(0, 300), bank });
    }
  }

  const ing = await handleIngest(env, req, path);
  if (ing) return ing;

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
  // adminfiókhoz kötelező a kétlépcsős azonosítás (a beállításához szükséges /api/account végpontok fent már lefutottak)
  if (u.role === 'admin' && !u.totp_enabled) throw new HttpError(403, 'Adminfiókhoz kötelező a kétlépcsős azonosítás (2FA) bekapcsolása.');

  for (const h of [handleUsers, handleData, handleIngestToken, handlePartners, handleChangelog]) {
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
      // a belső hiba részletei csak a naplóba kerülnek, a válaszba nem
      return withSecurityHeaders(json({ error: 'Szerverhiba. Próbáld újra később.' }, 500));
    }
  },

  async scheduled(ev: ScheduledController, env: Env, ctx: ExecutionContext) {
    // csak budapesti idő szerint 5, 9, 13, 17, 21 órakor (a cron UTC-ben mindkét időeltolásra fut)
    const hour = Number(
      new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Budapest', hour: '2-digit', hourCycle: 'h23' }).format(new Date(ev.scheduledTime)),
    );
    if (!SYNC_HOURS.includes(hour)) {
      // a NAV első szinkronja nem vár a következő szinkron-órára
      if (navEnabled(env) && !(await getSetting(env, 'nav_last_sync')))
        ctx.waitUntil(
          syncNav(env).then(
            (r) => console.log('nav first sync', JSON.stringify(r)),
            (e) => console.error('nav first sync failed', e),
          ),
        );
      return;
    }
    ctx.waitUntil(
      syncAll(env)
        .then(
          (r) => console.log('sync', JSON.stringify(r)),
          (e) => console.error('sync failed', e),
        )
        // új, terv nélküli tételek (NAV-számla, banki tétel) → e-mail az adminoknak (ha van levélküldő)
        .then(() => notifyUnplanned(env).then((r) => console.log('notify', JSON.stringify(r))))
        // reggel 5-kor: a havi terv–tény pillanatkép (lezárt hónapok egyszer, a folyó hónap naponta)
        .then(() => (hour === SYNC_HOURS[0] ? refreshMonthStats(env, null).then((r) => console.log('stats', JSON.stringify(r))) : undefined))
        .catch((e) => console.error('stats failed', e)),
    );
  },
} satisfies ExportedHandler<Env>;
