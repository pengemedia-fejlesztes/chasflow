// Automatikus kivonat-feltöltés (pl. a Mac Letöltések mappájából): személyes, visszavonható feltöltési kulccsal.
// A kulcs csak az aggreg8 importra (XML vagy a Mac-bot JSON-ja) és az ütemezés lekérdezésére jó; a szerver csak a hash-ét tárolja.
import { A8_LIMITS, SYNC_HOURS, bankOfAccount, parseAggreg8, parseAggreg8Json, type A8Account } from '../shared/aggreg8';
import { requireRole, type User } from './auth';
import { importManualRows, payBillingoFromBank } from './bank';
import { Env, HttpError, audit, getSetting, json, now, randomId, safeEqual, setSetting, sha256 } from './util';

const KEY = 'import_token';
const LAST = 'ingest_last';
const REQ = 'ingest_request'; // kézi „szinkronizálj most” kérés időpontja (app, robot, Claude)
const REPORT = 'ingest_report';
const LAST_DATES = 'bank_last_dates'; // bankonként az utolsó banki tétel napja (feltöltéskor frissül)

/** Bankonként az utolsó banki tétel napja – feltöltés után számoljuk újra (teljes tábla olvasás, ezért nem lekérdezésenként). */
async function refreshLastDates(env: Env): Promise<Record<string, string>> {
  const rows = (
    await env.DB.prepare(
      "SELECT a.bank_name AS bank, MAX(t.date) AS d FROM bank_accounts a JOIN bank_tx t ON t.account_id = a.id WHERE a.provider = 'manual' GROUP BY a.bank_name",
    ).all<{ bank: string; d: string | null }>()
  ).results;
  const out = Object.fromEntries(rows.filter((r) => r.d).map((r) => [r.bank, r.d as string]));
  await setSetting(env, LAST_DATES, JSON.stringify(out));
  return out;
} // a Mac legutóbbi futásának jelentése (siker vagy hiba)

const budapestHour = () => Number(new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Budapest', hour: '2-digit', hourCycle: 'h23' }).format(new Date()));

/** Szinkron kérése: a Mac fél percen belül elindítja. */
export async function requestSync(env: Env, by: string) {
  await setSetting(env, REQ, JSON.stringify({ at: now(), by }));
}

async function ingestState(env: Env) {
  const [last, req, report] = await Promise.all([getSetting(env, LAST), getSetting(env, REQ), getSetting(env, REPORT)]);
  return {
    last: JSON.parse(last || 'null') as IngestLast | null,
    request: JSON.parse(req || 'null') as { at: number; by: string } | null,
    report: JSON.parse(report || 'null') as { at: number; ok: boolean; msg: string } | null,
  };
}

async function tokenUser(env: Env, req: Request): Promise<number> {
  const auth = req.headers.get('Authorization') || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
  const st = JSON.parse((await getSetting(env, KEY)) || 'null') as { hash: string; user_id: number } | null;
  if (!token || !st || !safeEqual(await sha256(token), st.hash)) throw new HttpError(401, 'Érvénytelen feltöltési kulcs.');
  return st.user_id;
}

export type IngestLast = { at: number; source: 'xml' | 'json'; ok: boolean; accounts: unknown[]; error?: string };

export async function handleIngest(env: Env, req: Request, path: string): Promise<Response | null> {
  // a Mac-bot innen olvassa, mikor kell feltöltenie (= a banki szinkron órái), és mikor sikerült utoljára
  if (path === '/api/ingest/status' && req.method === 'GET') {
    await tokenUser(env, req);
    // bankonként a legutolsó banki tétel napja; a Mac ettől 7 nappal korábbtól kéri le az új tételeket
    // (a bankok visszamenő dátummal is könyvelnek; a duplikációt a feltöltés kiszűri)
    // a Mac 30 másodpercenként kérdez: csak a tárolt értékeket olvassuk (a banki tételeket nem – az D1 napi olvasási keretét emésztené)
    const last_dates = JSON.parse((await getSetting(env, LAST_DATES)) || 'null') || (await refreshLastDates(env));
    const ds = Object.values(last_dates) as string[];
    const since = ds.length ? new Date(Date.parse(ds.reduce((a, d) => (d < a ? d : a))) - 7 * 86400_000).toISOString().slice(0, 10) : null;
    const st = await ingestState(env);
    // pótlás: ha napközben 4,5 óránál régebben volt sikeres feltöltés (pl. aludt a Mac), a Mac magától újrafuttatja
    const h = budapestHour();
    const due = h >= SYNC_HOURS[0] && h < 23 && (!st.last?.ok || now() - st.last.at > 4.5 * 3600_000);
    return json({ sync_hours: SYNC_HOURS, timezone: 'Europe/Budapest', last_dates, since, ...st, requested_at: st.request?.at || 0, due });
  }
  // szinkron kérése a feltöltési kulccsal (pl. a Marveen robotból)
  if (path === '/api/ingest/request' && req.method === 'POST' && (req.headers.get('Authorization') || '').startsWith('Bearer ')) {
    await tokenUser(env, req);
    await requestSync(env, 'robot');
    return json({ ok: true });
  }
  // a Mac jelentése minden futás végén (siker vagy hiba) – a felületen és a diagnosztikában látszik
  if (path === '/api/ingest/report' && req.method === 'POST') {
    await tokenUser(env, req);
    const ok = new URL(req.url).searchParams.get('ok') === '1';
    const msg = (await req.text()).replace(/\s+/g, ' ').trim().slice(0, 2000);
    await setSetting(env, REPORT, JSON.stringify({ at: now(), ok, msg }));
    return json({ ok: true });
  }
  if (path !== '/api/ingest/aggreg8' || req.method !== 'POST') return null;
  const userId = await tokenUser(env, req);
  const len = Number(req.headers.get('Content-Length') || 0);
  if (len > A8_LIMITS.maxBytes) throw new HttpError(413, 'Túl nagy fájl.');
  const isJson = /json/i.test(req.headers.get('Content-Type') || '');
  let accs: A8Account[];
  let balances: Record<string, number> = {};
  let skipped = 0;
  try {
    const text = await req.text();
    if (text.length > A8_LIMITS.maxBytes) throw new Error('Túl nagy fájl.');
    if (isJson) {
      const r = parseAggreg8Json(JSON.parse(text));
      accs = r.accounts;
      balances = r.balances;
      skipped = r.skipped;
    } else accs = parseAggreg8(text);
  } catch (e: any) {
    const error = String(e?.message || e).slice(0, 200);
    await setSetting(env, LAST, JSON.stringify({ at: now(), source: isJson ? 'json' : 'xml', ok: false, accounts: [], error } satisfies IngestLast));
    throw new HttpError(400, error);
  }
  const manual = (
    await env.DB.prepare("SELECT bank_name, label, iban FROM bank_accounts WHERE provider = 'manual'").all<{
      bank_name: string;
      label: string;
      iban: string | null;
    }>()
  ).results;
  const out: unknown[] = [];
  const balanceDone = new Set<string>();
  for (const a of accs) {
    // bank: 1) ismert számlaszám, 2) bankkód (MagNet 162, BiNX 304), 3) a maradék kézi számla, ha egyértelmű
    let m = manual.find((x) => x.iban && x.iban.replace(/\s|-/g, '').toUpperCase() === a.account.toUpperCase());
    if (!m) {
      const bn = bankOfAccount(a.account);
      if (bn) m = manual.find((x) => x.bank_name.toLowerCase() === bn.toLowerCase()) || { bank_name: bn, label: 'Üzleti számla', iban: null };
    }
    if (!m) {
      const rest = manual.filter((x) => !x.iban && !bankOfAccount(x.bank_name) && !/magnet|binx/i.test(x.bank_name));
      if (rest.length === 1) m = rest[0];
    }
    if (!m) {
      out.push({ account: a.account.slice(-4), skipped: a.rows.length, error: 'ismeretlen számla – töltsd fel egyszer kézzel az appban' });
      continue;
    }
    const balance = balances[a.account.toUpperCase()];
    if (balance !== undefined) balanceDone.add(a.account.toUpperCase());
    const r = await importManualRows(env, userId, {
      bank_name: m.bank_name,
      label: m.label,
      rows: a.rows,
      iban: a.account,
      ...(balance !== undefined ? { balance: String(balance) } : {}),
    });
    const last = a.rows.reduce((d, x) => (x.date > d ? x.date : d), '');
    out.push({ bank: r.bank, rows: r.rows, inbox: r.inbox, auto: r.auto, duplicates: r.duplicates, last_date: last });
  }
  // egyenleg azokra a számlákra is, amelyeken most nem volt új tétel
  for (const [acc, amount] of Object.entries(balances)) {
    if (balanceDone.has(acc)) continue;
    const m =
      manual.find((x) => x.iban && x.iban.replace(/\s|-/g, '').toUpperCase() === acc) ||
      manual.find((x) => x.bank_name.toLowerCase() === (bankOfAccount(acc) || '').toLowerCase());
    if (!m) continue;
    await env.DB.prepare("UPDATE bank_accounts SET balance = ?, balance_at = ? WHERE provider = 'manual' AND bank_name = ? AND label = ?")
      .bind(amount, now(), m.bank_name, m.label)
      .run();
    out.push({ bank: m.bank_name, rows: 0, balance: amount });
  }
  await audit(env, userId, 'ingest_aggreg8', { source: isJson ? 'json' : 'xml', skipped, accounts: out });
  await setSetting(env, LAST, JSON.stringify({ at: now(), source: isJson ? 'json' : 'xml', ok: true, accounts: out } satisfies IngestLast));
  await refreshLastDates(env);
  const billingo_paid = await payBillingoFromBank(env).catch((e) => ({ error: String(e?.message || e) }));
  return json({ ok: true, accounts: out, skipped, sync_hours: SYNC_HOURS, billingo_paid });
}

/** Kulcs létrehozása (a régi érvényét veszti) / visszavonása – adminnak. */
export async function handleIngestToken(env: Env, req: Request, path: string, u: User): Promise<Response | null> {
  if (path === '/api/ingest/request' && req.method === 'POST') {
    requireRole(u, 'admin', 'member');
    await requestSync(env, u.email);
    return json({ ok: true });
  }
  if (path !== '/api/ingest/token') return null;
  requireRole(u, 'admin');
  if (req.method === 'POST') {
    const token = randomId('cfi_') + randomId();
    await setSetting(env, KEY, JSON.stringify({ hash: await sha256(token), user_id: u.id, created: now() }));
    await audit(env, u.id, 'ingest_token_created');
    return json({ token });
  }
  if (req.method === 'DELETE') {
    await setSetting(env, KEY, null);
    await audit(env, u.id, 'ingest_token_revoked');
    return json({ ok: true });
  }
  if (req.method === 'GET') {
    const st = JSON.parse((await getSetting(env, KEY)) || 'null') as { created: number } | null;
    return json({ active: !!st, created: st?.created || null, ...(await ingestState(env)), sync_hours: SYNC_HOURS });
  }
  return null;
}
