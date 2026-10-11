// Automatikus kivonat-feltöltés (pl. a Mac Letöltések mappájából): személyes, visszavonható feltöltési kulccsal.
// A kulcs csak az aggreg8 XML importra jó; a szerver csak a hash-ét tárolja.
import { bankOfAccount, parseAggreg8 } from '../shared/aggreg8';
import { requireRole, type User } from './auth';
import { importManualRows } from './bank';
import { Env, HttpError, audit, getSetting, json, now, randomId, safeEqual, setSetting, sha256 } from './util';

const KEY = 'import_token';

export async function handleIngest(env: Env, req: Request, path: string): Promise<Response | null> {
  if (path !== '/api/ingest/aggreg8' || req.method !== 'POST') return null;
  const auth = req.headers.get('Authorization') || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
  const st = JSON.parse((await getSetting(env, KEY)) || 'null') as { hash: string; user_id: number } | null;
  if (!token || !st || !safeEqual(await sha256(token), st.hash)) throw new HttpError(401, 'Érvénytelen feltöltési kulcs.');
  const len = Number(req.headers.get('Content-Length') || 0);
  if (len > 10 * 1024 * 1024) throw new HttpError(413, 'Túl nagy fájl.');
  let accs;
  try {
    accs = parseAggreg8(await req.text());
  } catch (e: any) {
    throw new HttpError(400, String(e?.message || e));
  }
  const manual = (
    await env.DB.prepare("SELECT bank_name, label, iban FROM bank_accounts WHERE provider = 'manual'").all<{
      bank_name: string;
      label: string;
      iban: string | null;
    }>()
  ).results;
  const out: unknown[] = [];
  for (const a of accs) {
    // bank: 1) ismert számlaszám, 2) bankkód (MagNet), 3) a maradék kézi számla (pl. BiNX), ha egyértelmű
    let m = manual.find((x) => x.iban && x.iban.replace(/\s|-/g, '') === a.account);
    if (!m) {
      const bn = bankOfAccount(a.account);
      if (bn) m = manual.find((x) => x.bank_name.toLowerCase() === bn.toLowerCase()) || { bank_name: bn, label: 'Üzleti számla', iban: null };
    }
    if (!m) {
      const rest = manual.filter((x) => !x.iban && !bankOfAccount(x.bank_name) && !/magnet/i.test(x.bank_name));
      if (rest.length === 1) m = rest[0];
    }
    if (!m) {
      out.push({ account: a.account.slice(-4), skipped: a.rows.length, error: 'ismeretlen számla – töltsd fel egyszer kézzel az appban' });
      continue;
    }
    const r = await importManualRows(env, st.user_id, { bank_name: m.bank_name, label: m.label, rows: a.rows, iban: a.account });
    out.push({ bank: r.bank, rows: r.rows, inbox: r.inbox, auto: r.auto, duplicates: r.duplicates });
  }
  await audit(env, st.user_id, 'ingest_aggreg8', out);
  return json({ ok: true, accounts: out });
}

/** Kulcs létrehozása (a régi érvényét veszti) / visszavonása – adminnak. */
export async function handleIngestToken(env: Env, req: Request, path: string, u: User): Promise<Response | null> {
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
    return json({ active: !!st, created: st?.created || null });
  }
  return null;
}
