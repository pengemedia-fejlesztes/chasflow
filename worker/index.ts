// Cashflow tervező – Cloudflare Worker belépési pont (API + ütemezett szinkron).
import { currentUser, handleAccount, handleAuth, handleUsers } from './auth';
import { handleBank, payBillingoFromBank, reapplyRules, syncAll } from './bank';
import { autoPayBillingo } from './billingo';
import * as eb from './enablebanking';
import { handleRules } from './rules';
import { navEnabled, syncNav } from './nav';
import { handleIngest, handleIngestToken } from './ingest';
import { handlePartners } from './partners';
import { handleCatalog } from './catalog';
import { handleTasks } from './tasks';
import { handleAccess, loadAccessMap, twofaMode } from './access';
import { a8KeepAlive, handleAggreg8Server } from './aggreg8srv';
import { accessOf, allowed, needs2fa } from '../shared/access';
import { handleStock } from './stock';
import { notifyUnplanned } from './notify';
import { refreshMonthStats } from './stats';
import { handleData } from './data';
import { handleChangelog } from './changelog';
import { Env, HttpError, audit, getSetting, json, readJson, safeEqual, setSetting, withSecurityHeaders } from './util';
import { SYNC_HOURS } from '../shared/aggreg8';
import { isWorkday } from '../shared/workdays';

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

  // olcsó változásfigyelés: az oldal csak ezt az egy sort kérdezi percenként, és csak változáskor tölti újra az adatokat
  if (path === '/api/version' && req.method === 'GET') return json({ rev: (await getSetting(env, 'data_rev')) || '0' });

  // böngészőben történt kirajzolási hiba naplózása (a hibakereséshez)
  if (path === '/api/client-error' && req.method === 'POST') {
    const b = await readJson(req).catch(() => ({}));
    console.error('client-error', u.email, JSON.stringify(b).slice(0, 2500));
    await audit(env, u.id, 'client_error', {
      message: String((b as any).message || '').slice(0, 300),
      url: String((b as any).url || '').slice(0, 100),
      component: String((b as any).component || '').slice(0, 600),
    }).catch(() => null);
    return json({ ok: true });
  }
  const acc = await handleAccount(env, req, path, u);
  if (acc) return acc;
  if (u.must_change_pw) throw new HttpError(403, 'Először változtasd meg az ideiglenes jelszavadat.');
  // adminfiókhoz kötelező a kétlépcsős azonosítás (a beállításához szükséges /api/account végpontok fent már lefutottak)
  if (!u.totp_enabled && needs2fa(await twofaMode(env), u.role))
    throw new HttpError(403, 'A kétlépcsős azonosítás (2FA) bekapcsolása kötelező. Állítsd be a hitelesítő alkalmazással.');
  // menüpont- és adatkör-jogosultság (admin mindenhez hozzáfér)
  const access = accessOf(u, await loadAccessMap(env));
  if (!allowed(path, access)) throw new HttpError(403, 'Ehhez nincs jogosultságod. Kérd az adminisztrátort.');

  for (const h of [
    handleUsers,
    handleData,
    handleIngestToken,
    handlePartners,
    handleAccess,
    handleAggreg8Server,
    handleCatalog,
    handleTasks,
    handleStock,
    handleChangelog,
  ]) {
    const r = await h(env, req, path, u);
    if (r) return r;
  }
  const rr = await handleRules(env, req, path, u, () => reapplyRules(env));
  if (rr) return rr;
  const b = await handleBank(env, req, path, u, url);
  if (b) return b;
  throw new HttpError(404, 'Nincs ilyen végpont.');
}

const bumpRev = (env: Env) =>
  env.DB.prepare("INSERT INTO settings (key, value) VALUES ('data_rev', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
    .bind(String(Date.now()))
    .run();

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    try {
      const res = await route(req, env);
      // minden sikeres módosítás után új adat-verzió (a megnyitott oldalak ebből tudják, hogy újra kell tölteni)
      if (req.method !== 'GET' && res.status < 400) await bumpRev(env).catch(() => null);
      return withSecurityHeaders(res);
    } catch (e: any) {
      if (e instanceof HttpError) return withSecurityHeaders(json({ error: e.message }, e.status));
      console.error(e);
      // diagnosztikához: a legutóbbi szerverhibák (végpont + hibaüzenet, adat nélkül) – a diag lekérdezés olvassa
      try {
        const u = new URL(req.url);
        const row = await env.DB.prepare("SELECT value FROM settings WHERE key = 'server_errors'").first<{ value: string }>();
        const list: unknown[] = JSON.parse(row?.value || '[]');
        list.unshift({
          at: new Date().toISOString(),
          m: req.method,
          p: u.pathname,
          e: String(e?.message || e).slice(0, 300),
          s: String(e?.stack || '').slice(0, 400),
        });
        await env.DB.prepare("INSERT INTO settings (key, value) VALUES ('server_errors', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
          .bind(JSON.stringify(list.slice(0, 20)))
          .run();
      } catch {}
      // a belső hiba részletei csak a naplóba kerülnek, a válaszba nem
      return withSecurityHeaders(json({ error: 'Szerverhiba. Próbáld újra később.' }, 500));
    }
  },

  async scheduled(ev: ScheduledController, env: Env, ctx: ExecutionContext) {
    // aggreg8-munkamenet életben tartása (4 óránként, hétvégén is): csak megújít, nem szinkronizál
    if ((ev as any).cron === 'keepalive') {
      ctx.waitUntil(a8KeepAlive(env).then((r) => console.log('aggreg8 keepalive', r)));
      return;
    }
    // minden ütemezett futásnál (szinkron-órán kívül és munkaszüneti napon is) életben tartjuk az aggreg8-belépést
    ctx.waitUntil(a8KeepAlive(env).then((r) => console.log('aggreg8 keepalive', r)));
    // csak budapesti idő szerint 5, 9, 13, 17, 21 órakor (a cron UTC-ben mindkét időeltolásra fut)
    const hour = Number(
      new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Budapest', hour: '2-digit', hourCycle: 'h23' }).format(new Date(ev.scheduledTime)),
    );
    const day = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Budapest' }).format(new Date(ev.scheduledTime));
    // csak munkanapokon (hétvége, ünnep, áthelyezett pihenőnap kimarad; ledolgozós szombaton fut)
    if (!SYNC_HOURS.includes(hour) || !isWorkday(day)) {
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
          (r) => (console.log('sync', JSON.stringify(r)), bumpRev(env)),
          (e) => console.error('sync failed', e),
        )
        // a NAV és a Billingo után a bankok: a Mac 30 mp-en belül elindítja az aggreg8 letöltést
        .then(() =>
          setSetting(env, 'ingest_request', JSON.stringify({ at: Date.now(), by: 'ütemezett' })).catch((e) => console.error('bank request failed', e)),
        )
        // új, terv nélküli tételek (NAV-számla, banki tétel) → e-mail az adminoknak (ha van levélküldő)
        .then(() => notifyUnplanned(env).then((r) => console.log('notify', JSON.stringify(r))))
        // reggel 5-kor: a havi terv–tény pillanatkép (lezárt hónapok egyszer, a folyó hónap naponta)
        .then(() => (hour === SYNC_HOURS[0] ? refreshMonthStats(env, null).then((r) => console.log('stats', JSON.stringify(r))) : undefined))
        .catch((e) => console.error('stats failed', e)),
    );
  },
} satisfies ExportedHandler<Env>;
