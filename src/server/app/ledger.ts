// Számlatörténet: bankszámlánként havi nyitó / bejövő / kimenő / záró egyenleg és a hónap tranzakciói (kapcsolt számlával),
// valamint a készpénz-„bankszámla” (kézi készpénzes tételek). Egyenleg CSAK banki adatból: a bank által szinkronkor jelentett
// könyvelt egyenleg (dátummal mentve) vagy a bankszámlakivonat szerinti záró egyenleg (kézzel rögzítve). Nem számolunk vissza.
import { requireRole, type User } from './auth';
import { filesFor } from './txfiles';
import { logChange } from './changelog';
import { Env, HttpError, ensureOnce, getSetting, json, now, randomId, readJson, setSetting, todayHu } from './util';

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
const prevDay = (d: string) => new Date(Date.parse(d + 'T12:00:00Z') - 86400000).toISOString().slice(0, 10);
const prevYm = (ym: string) => {
  const [y, m] = ym.split('-').map(Number);
  return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, '0')}`;
};
const nextYm = (ym: string) => {
  const [y, m] = ym.split('-').map(Number);
  return m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`;
};

const BAL_DDL = `CREATE TABLE IF NOT EXISTS bank_balances (
  id VARCHAR(40) NOT NULL PRIMARY KEY,
  account_id VARCHAR(40) NOT NULL,
  date VARCHAR(10) NOT NULL,
  balance DOUBLE NOT NULL,
  source VARCHAR(12) NOT NULL,
  created_at BIGINT NOT NULL
)`;
const ensureBalances = ensureOnce('bank_balances ddl', (env) => env.DB.prepare(BAL_DDL).run());

/** a bank által jelentett egyenlegek mentése (a since óta frissített számlákra), naponta számlánként a legutolsó */
export async function snapshotBankBalances(env: Env, since: number, source: 'aggreg8' | 'kivonat') {
  if (!(await ensureBalances(env))) return;
  const accs = (
    await env.DB.prepare("SELECT id, balance, balance_at FROM bank_accounts WHERE provider <> 'cash' AND balance IS NOT NULL AND balance_at >= ?")
      .bind(since)
      .all<{ id: string; balance: number; balance_at: number }>()
  ).results;
  const day = todayHu();
  for (const a of accs) {
    await env.DB.prepare('DELETE FROM bank_balances WHERE account_id = ? AND date = ? AND source = ?').bind(a.id, day, source).run();
    await env.DB.prepare('INSERT INTO bank_balances (id, account_id, date, balance, source, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .bind(randomId('bb'), a.id, day, Number(a.balance), source, now())
      .run();
  }
}

/** egy banki egyenleg-adat: összeg, nap, forrás (aggreg8 = szinkronkor a bank jelentette; kivonat = bankszámlakivonat) */
export interface BankBal {
  amount: number;
  date: string;
  source: string;
}

export interface LedgerMonth {
  ym: string;
  accounts: Record<string, { open: BankBal | null; close: BankBal | null; inc: number; out: number; n: number }>;
}

/**
 * Havi összesítés számlánként. Bejövő / kimenő: a hónap banki tételeinek összege. Záró egyenleg: a kivonat szerinti
 * záró egyenleg, ha rögzítették; különben a hónapon belüli utolsó, a bank által jelentett egyenleg (dátummal).
 * Nyitó egyenleg: az előző hónap záró egyenlege (kivonat), vagy a hónap első napja előtti utolsó banki egyenleg.
 */
export async function ledgerSummary(env: Env): Promise<{ accounts: Acc[]; months: LedgerMonth[] }> {
  await ensureBalances(env);
  const accounts = (
    await env.DB.prepare('SELECT id, provider, bank_name, label, iban, balance, balance_at FROM bank_accounts WHERE active = 1 ORDER BY bank_name').all<Acc>()
  ).results.map((a) => ({ ...a, balance: a.balance === null ? null : Number(a.balance) }));
  const rows = (
    await env.DB.prepare(
      'SELECT account_id, substr(date, 1, 7) AS ym, SUM(CASE WHEN amount > 0 THEN amount ELSE 0 END) AS inc, SUM(CASE WHEN amount < 0 THEN amount ELSE 0 END) AS outv, COUNT(*) AS n FROM bank_tx GROUP BY account_id, substr(date, 1, 7)',
    ).all<{ account_id: string; ym: string; inc: number; outv: number; n: number }>()
  ).results;
  // kiinduló adat: ha egy bankszámlához még nincs mentett banki egyenleg, a legutóbb jelentett egyenleg a jelentés napjával
  for (const ac of accounts) {
    if (ac.provider === 'cash' || ac.balance === null || !ac.balance_at || Number(ac.balance_at) < Date.UTC(2020, 0, 1)) continue;
    const has = await env.DB.prepare('SELECT id FROM bank_balances WHERE account_id = ? LIMIT 1').bind(ac.id).first();
    if (!has) {
      const day = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Budapest' }).format(new Date(Number(ac.balance_at)));
      await env.DB.prepare('INSERT INTO bank_balances (id, account_id, date, balance, source, created_at) VALUES (?, ?, ?, ?, ?, ?)')
        .bind(randomId('bb'), ac.id, day, Number(ac.balance), 'aggreg8', now())
        .run();
    }
  }
  const bals = (
    await env.DB.prepare('SELECT account_id, date, balance, source FROM bank_balances ORDER BY date, created_at').all<{
      account_id: string;
      date: string;
      balance: number;
      source: string;
    }>()
  ).results.map((b) => ({ ...b, balance: Number(b.balance) }));
  const cur = todayHu().slice(0, 7);
  const first = [...rows.map((r) => r.ym), ...bals.map((b) => b.date.slice(0, 7))].reduce((m, x) => (x < m ? x : m), cur);
  const yms: string[] = [];
  for (let ym = first; ym <= cur; ym = nextYm(ym)) yms.push(ym);
  const flow = new Map<string, { inc: number; out: number; n: number }>();
  for (const r of rows) flow.set(r.account_id + '|' + r.ym, { inc: Number(r.inc) || 0, out: Number(r.outv) || 0, n: Number(r.n) || 0 });
  const cashOpening = Number((await getSetting(env, 'cash_opening')) || 0);
  const months: LedgerMonth[] = yms.map((ym) => ({ ym, accounts: {} }));
  // napi banki tételek számlánként: a visszavezetéshez (egy későbbi banki egyenlegből a közbeeső banki tételek levonásával)
  const txs = (
    await env.DB.prepare("SELECT account_id, date, amount FROM bank_tx WHERE account_id <> 'cash' ORDER BY date").all<{
      account_id: string;
      date: string;
      amount: number;
    }>()
  ).results;
  for (const a of accounts) {
    const mine = bals.filter((b) => b.account_id === a.id);
    // a hónap záró egyenlege: kivonat (a hónapra), különben a hónapon belüli utolsó banki egyenleg
    const closeOf = (ym: string): BankBal | null => {
      const st = mine.filter((b) => b.source === 'kivonat' && b.date.slice(0, 7) === ym).pop();
      if (st) return { amount: st.balance, date: st.date, source: 'kivonat' };
      const last = mine.filter((b) => b.date.slice(0, 7) === ym).pop();
      return last ? { amount: last.balance, date: last.date, source: last.source } : null;
    };
    const myTx = txs.filter((t) => t.account_id === a.id).map((t) => ({ date: t.date, amount: Number(t.amount) || 0 }));
    const firstTx = myTx[0]?.date || null;
    /** a nap végi egyenleg visszavezetve: a legközelebbi későbbi banki egyenlegből levonva a közbeeső banki tételek
     *  (csak ha arra a napra már van banki tétel-előzmény, különben nem tudható) */
    const derive = (day: string): BankBal | null => {
      if (!firstTx || day < prevDay(firstTx)) return null;
      const anchor = mine.find((b) => b.date >= day);
      if (!anchor) return null;
      const between = myTx.filter((t) => t.date > day && t.date <= anchor.date).reduce((x, t) => x + t.amount, 0);
      return { amount: Math.round(anchor.balance - between), date: day, source: 'visszavezetve' };
    };
    let cashRun = cashOpening;
    for (const [i, ym] of yms.entries()) {
      const f = flow.get(a.id + '|' + ym) || { inc: 0, out: 0, n: 0 };
      if (a.provider === 'cash') {
        // a házipénztár a saját nyilvántartásunk: nyitó összeg + a rögzített készpénzes tételek
        const open = { amount: cashRun, date: ym + '-01', source: 'pénztár' };
        cashRun += f.inc + f.out;
        months[i].accounts[a.id] = { open, close: { amount: cashRun, date: lastDay(ym), source: 'pénztár' }, inc: f.inc, out: f.out, n: f.n };
        continue;
      }
      const prevSt = mine.filter((b) => b.source === 'kivonat' && b.date.slice(0, 7) === prevYm(ym)).pop();
      const before = mine.filter((b) => b.date < ym + '-01').pop();
      const open: BankBal | null = prevSt
        ? { amount: prevSt.balance, date: prevSt.date, source: 'kivonat' }
        : before
          ? { amount: before.balance, date: before.date, source: before.source }
          : null;
      // nyitó: az előző havi kivonat, különben visszavezetve az előző hónap utolsó napjára, végül az utolsó korábbi banki egyenleg
      const stClose = mine.filter((b) => b.source === 'kivonat' && b.date.slice(0, 7) === ym).pop();
      const close: BankBal | null = stClose
        ? { amount: stClose.balance, date: stClose.date, source: 'kivonat' }
        : ym === cur
          ? closeOf(ym)
          : derive(lastDay(ym)) || closeOf(ym);
      months[i].accounts[a.id] = {
        open: open?.source === 'kivonat' ? open : derive(prevDay(ym + '-01')) || open,
        close,
        inc: f.inc,
        out: f.out,
        n: f.n,
      };
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
  invoices: { kind: 'billingo' | 'nav'; number: string; id?: string | number }[];
  files: import('./txfiles').TxFile[];
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
      `SELECT id, number, plan_id, paid_by_tx FROM billingo_docs WHERE cancelled = 0 AND (paid_by_tx IN (${ph(ids.length)})${plans.length ? ` OR plan_id IN (${ph(plans.length)})` : ''})`,
    )
      .bind(...ids, ...plans)
      .all<{ id: number; number: string; plan_id: string | null; paid_by_tx: string | null }>()
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
  const files = await filesFor(env, ids);
  return tx.map((t) => {
    const inv: LedgerTx['invoices'] = [];
    for (const b of bill)
      if (b.number && (b.paid_by_tx === t.id || (t.plan_id && b.plan_id === t.plan_id))) inv.push({ kind: 'billingo', number: b.number, id: b.id });
    for (const n of nav)
      if (n.invoice_number && ((t.plan_id && n.plan_id === t.plan_id) || (t.actual_id && n.actual_id === t.actual_id)))
        inv.push({ kind: 'nav', number: n.invoice_number });
    const seen = new Set<string>();
    return {
      ...t,
      amount: Number(t.amount),
      invoices: inv.filter((x) => (seen.has(x.number) ? false : (seen.add(x.number), true))),
      files: files.get(t.id) || [],
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
  if (path === '/api/bank/statement' && req.method === 'PUT') {
    // bankszámlakivonat szerinti záró egyenleg egy hónapra (a kivonat dátumával)
    requireRole(u, 'admin');
    const b = await readJson(req);
    const account = String(b.account_id || '');
    const date = String(b.date || '');
    const amount = Math.round(
      Number(
        String(b.amount ?? '')
          .replace(/\s/g, '')
          .replace(',', '.'),
      ),
    );
    if (!DATE.test(date)) throw new HttpError(400, 'Hibás kivonat-dátum.');
    if (!Number.isFinite(amount)) throw new HttpError(400, 'Hibás egyenleg.');
    const acc = await env.DB.prepare("SELECT id, bank_name FROM bank_accounts WHERE id = ? AND provider <> 'cash'")
      .bind(account)
      .first<{ id: string; bank_name: string }>();
    if (!acc) throw new HttpError(404, 'Nincs ilyen bankszámla.');
    await ensureBalances(env);
    await env.DB.prepare("DELETE FROM bank_balances WHERE account_id = ? AND source = 'kivonat' AND substr(date, 1, 7) = ?")
      .bind(account, date.slice(0, 7))
      .run();
    if (b.clear) return json({ ok: true });
    await env.DB.prepare('INSERT INTO bank_balances (id, account_id, date, balance, source, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .bind(randomId('bb'), account, date, amount, 'kivonat', now())
      .run();
    await logChange(env, u.id, 'bank_statement', `Kivonat szerinti záró egyenleg: ${acc.bank_name} ${date} · ${amount} Ft`, [], null);
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
