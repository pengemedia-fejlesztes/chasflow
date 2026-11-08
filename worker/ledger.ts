// Számlatörténet: bankszámlánként havi nyitó / bejövő / kimenő / záró egyenleg és a hónap tranzakciói (kapcsolt számlával),
// valamint a készpénz-„bankszámla” (kézi készpénzes tételek). A múltbeli egyenleg a mostani egyenlegből visszafelé számolt:
// záró(hónap) = mostani egyenleg − a hónap utáni tételek összege.
import { requireRole, type User } from './auth';
import { logChange } from './changelog';
import { Env, HttpError, getSetting, json, now, randomId, readJson, setSetting, todayHu } from './util';

export const CASH_ID = 'cash';

interface Acc {
  id: string;
  provider: string;
  bank_name: string;
  label: string;
  iban: string | null;
  balance: number | null;
  balance_at: number | null;
}

const lastDay = (ym: string) => {
  const [y, m] = ym.split('-').map(Number);
  return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
};
const prevYm = (ym: string) => {
  const [y, m] = ym.split('-').map(Number);
  return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, '0')}`;
};
const nextYm = (ym: string) => {
  const [y, m] = ym.split('-').map(Number);
  return m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`;
};

export interface LedgerMonth {
  ym: string;
  accounts: Record<string, { open: number; inc: number; out: number; close: number; n: number }>;
}

/** havi összesítés minden számlára, a legkorábbi tétel hónapjától a mostaniig */
export async function ledgerSummary(env: Env): Promise<{ accounts: Acc[]; months: LedgerMonth[] }> {
  const accounts = (
    await env.DB.prepare('SELECT id, provider, bank_name, label, iban, balance, balance_at FROM bank_accounts WHERE active = 1 ORDER BY bank_name').all<Acc>()
  ).results.map((a) => ({ ...a, balance: a.balance === null ? null : Number(a.balance) }));
  const rows = (
    await env.DB.prepare(
      'SELECT account_id, substr(date, 1, 7) AS ym, SUM(CASE WHEN amount > 0 THEN amount ELSE 0 END) AS inc, SUM(CASE WHEN amount < 0 THEN amount ELSE 0 END) AS outv, COUNT(*) AS n FROM bank_tx GROUP BY account_id, substr(date, 1, 7)',
    ).all<{ account_id: string; ym: string; inc: number; outv: number; n: number }>()
  ).results;
  const cur = todayHu().slice(0, 7);
  const first = rows.reduce((m, r) => (r.ym < m ? r.ym : m), cur);
  const yms: string[] = [];
  for (let ym = first; ym <= cur; ym = nextYm(ym)) yms.push(ym);
  const byAcc = new Map<string, Map<string, { inc: number; out: number; n: number }>>();
  for (const r of rows) {
    const m = byAcc.get(r.account_id) || new Map();
    m.set(r.ym, { inc: Number(r.inc) || 0, out: Number(r.outv) || 0, n: Number(r.n) || 0 });
    byAcc.set(r.account_id, m);
  }
  const months: LedgerMonth[] = yms.map((ym) => ({ ym, accounts: {} }));
  for (const a of accounts) {
    const m = byAcc.get(a.id) || new Map();
    // visszafelé: a mostani egyenlegből (a jövőbeli dátumú tételek nélkül) a hónapok záró egyenlege
    let close = Number(a.balance || 0);
    for (let i = yms.length - 1; i >= 0; i--) {
      const x = m.get(yms[i]) || { inc: 0, out: 0, n: 0 };
      const open = close - x.inc - x.out;
      months[i].accounts[a.id] = { open, inc: x.inc, out: x.out, close, n: x.n };
      close = open;
    }
  }
  return { accounts, months };
}

export interface LedgerTx {
  id: string;
  account_id: string;
  date: string;
  amount: number;
  partner: string;
  memo: string;
  status: string;
  leaf_id: string | null;
  plan_id: string | null;
  actual_id: string | null;
  invoices: { kind: 'billingo' | 'nav'; number: string }[];
}

/** a hónap tranzakciói (egy vagy minden számlán), a kapcsolt Billingo- és NAV-számlákkal */
export async function ledgerMonth(env: Env, ym: string, account?: string): Promise<LedgerTx[]> {
  const from = ym + '-01';
  const to = lastDay(ym);
  const tx = (
    await (
      account
        ? env.DB.prepare(
            'SELECT id, account_id, date, amount, partner, memo, status, leaf_id, plan_id, actual_id FROM bank_tx WHERE date >= ? AND date <= ? AND account_id = ? ORDER BY date DESC, created_at DESC',
          ).bind(from, to, account)
        : env.DB.prepare(
            'SELECT id, account_id, date, amount, partner, memo, status, leaf_id, plan_id, actual_id FROM bank_tx WHERE date >= ? AND date <= ? ORDER BY date DESC, created_at DESC',
          ).bind(from, to)
    ).all<any>()
  ).results;
  if (!tx.length) return [];
  const ids = tx.map((t) => t.id);
  const plans = tx.map((t) => t.plan_id).filter(Boolean);
  const actuals = tx.map((t) => t.actual_id).filter(Boolean);
  const ph = (n: number) => Array(n).fill('?').join(',');
  const bill = (
    await env.DB.prepare(
      `SELECT number, plan_id, paid_by_tx FROM billingo_docs WHERE cancelled = 0 AND (paid_by_tx IN (${ph(ids.length)})${plans.length ? ` OR plan_id IN (${ph(plans.length)})` : ''})`,
    )
      .bind(...ids, ...plans)
      .all<{ number: string; plan_id: string | null; paid_by_tx: string | null }>()
  ).results;
  const nav =
    plans.length || actuals.length
      ? (
          await env.DB.prepare(
            `SELECT invoice_number, plan_id, actual_id FROM nav_invoices WHERE ${[plans.length ? `plan_id IN (${ph(plans.length)})` : '', actuals.length ? `actual_id IN (${ph(actuals.length)})` : ''].filter(Boolean).join(' OR ')}`,
          )
            .bind(...plans, ...actuals)
            .all<{ invoice_number: string; plan_id: string | null; actual_id: string | null }>()
        ).results
      : [];
  return tx.map((t) => {
    const inv: LedgerTx['invoices'] = [];
    for (const b of bill) if (b.number && (b.paid_by_tx === t.id || (t.plan_id && b.plan_id === t.plan_id))) inv.push({ kind: 'billingo', number: b.number });
    for (const n of nav)
      if (n.invoice_number && ((t.plan_id && n.plan_id === t.plan_id) || (t.actual_id && n.actual_id === t.actual_id)))
        inv.push({ kind: 'nav', number: n.invoice_number });
    const seen = new Set<string>();
    return {
      ...t,
      amount: Number(t.amount),
      invoices: inv.filter((x) => (seen.has(x.number) ? false : (seen.add(x.number), true))),
    };
  });
}

/** a készpénz-számla létrehozása (első használatkor) */
async function ensureCash(env: Env) {
  const has = await env.DB.prepare('SELECT id FROM bank_accounts WHERE id = ?').bind(CASH_ID).first();
  if (!has)
    await env.DB.prepare(
      "INSERT INTO bank_accounts (id, provider, bank_name, label, iban, currency, balance, balance_at, active) VALUES (?, 'cash', 'Készpénz', 'Házipénztár', NULL, 'HUF', 0, ?, 1)",
    )
      .bind(CASH_ID, now())
      .run();
}

/** a készpénz egyenlege = nyitó összeg + az összes készpénzes tétel */
async function recalcCash(env: Env) {
  const opening = Number((await getSetting(env, 'cash_opening')) || 0);
  const s = await env.DB.prepare('SELECT COALESCE(SUM(amount), 0) AS s FROM bank_tx WHERE account_id = ?').bind(CASH_ID).first<{ s: number }>();
  await env.DB.prepare('UPDATE bank_accounts SET balance = ?, balance_at = ? WHERE id = ?')
    .bind(opening + Number(s?.s || 0), now(), CASH_ID)
    .run();
}

const YM = /^\d{4}-(0[1-9]|1[0-2])$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

export async function handleLedger(env: Env, req: Request, path: string, u: User): Promise<Response | null> {
  if (path === '/api/bank/ledger' && req.method === 'GET') {
    const url = new URL(req.url);
    const ym = url.searchParams.get('ym') || todayHu().slice(0, 7);
    if (!YM.test(ym)) throw new HttpError(400, 'Hibás hónap.');
    const account = url.searchParams.get('account') || undefined;
    const [sum, tx] = await Promise.all([ledgerSummary(env), ledgerMonth(env, ym, account)]);
    return json({
      ym,
      prev: prevYm(ym),
      next: nextYm(ym),
      accounts: sum.accounts,
      months: sum.months,
      tx,
      cashOpening: Number((await getSetting(env, 'cash_opening')) || 0),
    });
  }
  if (path === '/api/bank/cash' && req.method === 'POST') {
    requireRole(u, 'admin', 'member');
    const b = await readJson(req);
    const date = String(b.date || '');
    const amount = Math.round(
      Number(
        String(b.amount ?? '')
          .replace(/\s/g, '')
          .replace(',', '.'),
      ),
    );
    const partner = String(b.partner || '')
      .trim()
      .slice(0, 120);
    const memo = String(b.memo || '')
      .trim()
      .slice(0, 300);
    if (!DATE.test(date)) throw new HttpError(400, 'Hibás dátum.');
    if (!Number.isFinite(amount) || !amount || Math.abs(amount) > 1e10) throw new HttpError(400, 'Adj meg összeget (kiadás: mínusz, bevétel: plusz).');
    await ensureCash(env);
    const id = randomId('c');
    // a tétel a Bankszinkron beérkezett tételei közé kerül: ott kategorizálható és párosítható, mint a banki tétel
    await env.DB.prepare(
      "INSERT INTO bank_tx (id, account_id, ext_id, date, amount, currency, partner, memo, status, created_at) VALUES (?, ?, ?, ?, ?, 'HUF', ?, ?, 'new', ?)",
    )
      .bind(id, CASH_ID, 'cash:' + id, date, amount, partner, memo, now())
      .run();
    await recalcCash(env);
    await logChange(env, u.id, 'cash_tx', `Készpénz: ${amount > 0 ? '+' : ''}${amount} Ft · ${partner || memo || ''} (${date})`, [], null);
    return json({ ok: true, id });
  }
  const del = path.match(/^\/api\/bank\/cash\/([^/]+)$/);
  if (del && req.method === 'DELETE') {
    requireRole(u, 'admin', 'member');
    const t = await env.DB.prepare('SELECT id, status, amount, date FROM bank_tx WHERE id = ? AND account_id = ?')
      .bind(decodeURIComponent(del[1]), CASH_ID)
      .first<any>();
    if (!t) throw new HttpError(404, 'Nincs ilyen készpénzes tétel.');
    if (t.status === 'approved') throw new HttpError(409, 'Jóváhagyott tétel: előbb vond vissza a jóváhagyást a Bankszinkronban.');
    await env.DB.prepare('DELETE FROM bank_tx WHERE id = ?').bind(t.id).run();
    await recalcCash(env);
    await logChange(env, u.id, 'cash_tx_deleted', `Készpénzes tétel törölve: ${t.amount} Ft (${t.date})`, [], null);
    return json({ ok: true });
  }
  if (path === '/api/bank/cash/opening' && req.method === 'PUT') {
    requireRole(u, 'admin');
    const b = await readJson(req);
    const v = Math.round(Number(String(b.amount ?? '0').replace(/\s/g, '')));
    if (!Number.isFinite(v)) throw new HttpError(400, 'Hibás összeg.');
    await ensureCash(env);
    await setSetting(env, 'cash_opening', String(v));
    await recalcCash(env);
    await logChange(env, u.id, 'cash_opening', `Készpénz nyitó egyenlege: ${v} Ft`, [], null);
    return json({ ok: true });
  }
  return null;
}
