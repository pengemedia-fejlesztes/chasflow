// Bankkapcsolat (BiNX, Magnet … PSD2-n keresztül), banki tételek jóváhagyása, CSV import.
import { normalizeText, parseAmount, parseDate } from '../shared/categories';
import { namesMatch } from '../shared/billingopay';
import { matchPlan, partnerKey, suggestLeaf } from '../shared/match';
import { autoApprove, loadContains } from './rules';
import { payDate } from '../shared/workdays';
import type { Entry, Leaf } from '../shared/types';
import { isBudgetPlan } from '../shared/budget';
import { requireRole, type User } from './auth';
import { fillPartnerKind, fillPartnerTax, mergePartnerNames } from './partnertax';
import { attachInvoiceStmts, autoPayBillingo, promoteOfferLeaves, billingoPublicUrl, invoiceRefs, reconcileInvoicePlans, syncBillingo } from './billingo';
import { fetchInvoiceData, navEnabled, navInvoiceRefs, rematchNav, resolveNav, syncNav, type NavResolve } from './nav';
import * as eb from './enablebanking';
import { refreshVatPlans } from './vat';
import { Env, HttpError, audit, json, now, randomId, readJson, setSetting, todayHu } from './util';

const PREFERRED_BALANCE = ['CLAV', 'ITAV', 'CLBD', 'XPCD', 'ITBD', 'OPAV', 'PRCD'];

function pickBalance(bs: eb.EbBalance[]): { amount: number; currency: string } | null {
  for (const t of PREFERRED_BALANCE) {
    const b = bs.find((x) => x.balance_type === t);
    if (b) return { amount: Math.round(parseFloat(b.balance_amount.amount)), currency: b.balance_amount.currency };
  }
  const b = bs[0];
  return b ? { amount: Math.round(parseFloat(b.balance_amount.amount)), currency: b.balance_amount.currency } : null;
}

export async function matchingContext(env: Env) {
  const [leavesR, groupsR, rulesR, plansR] = await env.DB.batch([
    env.DB.prepare('SELECT * FROM leaves'),
    env.DB.prepare('SELECT id, section FROM groups'),
    env.DB.prepare('SELECT pattern, leaf_id FROM partner_rules'),
    env.DB.prepare("SELECT * FROM entries WHERE kind = 'plan' AND done = 0 AND date >= date('now', '-120 days')"),
  ]);
  const leaves = leavesR.results as unknown as Leaf[];
  const sec: Record<string, 'in' | 'out'> = {};
  (groupsR.results as any[]).forEach((g) => (sec[g.id] = g.section));
  const lg: Record<string, string> = {};
  leaves.forEach((l) => (lg[l.id] = l.group_id));
  const rules: Record<string, string> = {};
  // a korábbi tények megnevezéseiből tanult párok (pl. „X-Page” → Domain-Tárhely); a jóváhagyáskor tanult szabály felülírja
  const hist = await env.DB.prepare(
    "SELECT name, leaf_id, COUNT(*) AS n FROM entries WHERE kind = 'actual' AND name <> '' AND date >= date('now', '-3 years') GROUP BY name, leaf_id ORDER BY n",
  ).all<{ name: string; leaf_id: string }>();
  hist.results.forEach((r) => {
    const k = partnerKey(r.name);
    if (k.length >= 3 && !/^(havi dij|megbizasi dij|munkaber|egyszeri dij|szamla)$/.test(k)) rules[k] = r.leaf_id;
  });
  (rulesR.results as any[]).forEach((r) => (rules[r.pattern] = r.leaf_id));
  const sectionOf = (id: string) => sec[lg[id]] || 'out';
  const unforeseen = leaves.find((l) => !l.archived && sectionOf(l.id) === 'out' && normalizeText(l.label).startsWith('elore nem lathato'))?.id ?? null;
  return {
    leaves,
    sectionOf,
    rules,
    plans: plansR.results as unknown as Entry[],
    refs: { ...(await invoiceRefs(env)), ...(await navInvoiceRefs(env)) },
    unforeseen,
    contains: await loadContains(env),
  };
}

type Ctx = Awaited<ReturnType<typeof matchingContext>>;

function insertTxStmt(
  env: Env,
  ctx: Ctx,
  accountId: string,
  tx: { ext: string; date: string; amount: number; currency: string; partner: string; memo: string },
  status: 'new' | 'ignored' = 'new',
) {
  const leaf = suggestLeaf(tx, ctx.rules, ctx.leaves, ctx.sectionOf, ctx.contains);
  const plan = matchPlan({ ...tx, leaf_id: leaf }, ctx.plans, ctx.refs);
  return env.DB.prepare(
    `INSERT INTO bank_tx (id, account_id, ext_id, date, amount, currency, partner, memo, status, leaf_id, plan_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(account_id, ext_id) DO NOTHING`,
  ).bind(
    randomId('t'),
    accountId,
    tx.ext,
    tx.date,
    tx.amount,
    tx.currency,
    tx.partner.slice(0, 200),
    tx.memo.slice(0, 500),
    status,
    leaf ?? (plan ? plan.leaf_id : tx.amount < 0 ? ctx.unforeseen : null),
    plan?.id ?? null,
    now(),
  );
}

/** Első szinkronnál honnan kérjük a tételeket: az importált tények utáni naptól (max. 89 nap). */
async function initialFrom(env: Env): Promise<string> {
  const r = await env.DB.prepare("SELECT MAX(date) AS d FROM entries WHERE kind = 'actual' AND source = 'import'").first<{ d: string | null }>();
  const min = new Date(Date.now() - 89 * 86400_000).toISOString().slice(0, 10);
  if (!r?.d) return min;
  const next = new Date(Date.parse(r.d) + 86400_000).toISOString().slice(0, 10);
  return next > min ? next : min;
}

export async function syncBanks(env: Env): Promise<{ accounts: number; newTx: number; auto?: number; errors: string[] }> {
  const accts = await env.DB.prepare("SELECT * FROM bank_accounts WHERE provider = 'enablebanking' AND active = 1").all<any>();
  if (!accts.results.length) return { accounts: 0, newTx: 0, errors: [] };
  const ctx = await matchingContext(env);
  const before = await env.DB.prepare("SELECT COUNT(*) AS n FROM bank_tx WHERE status = 'new'").first<{ n: number }>();
  const errors: string[] = [];
  const first = await initialFrom(env);
  for (const a of accts.results) {
    try {
      if (a.valid_until && Date.parse(a.valid_until) < Date.now()) throw new Error('A banki hozzájárulás lejárt – kapcsold újra a Beállításokban.');
      const bal = pickBalance(await eb.getBalances(env, a.eb_account_uid));
      const last = await env.DB.prepare('SELECT MAX(date) AS d FROM bank_tx WHERE account_id = ?').bind(a.id).first<{ d: string | null }>();
      const from = last?.d ? new Date(Date.parse(last.d) - 7 * 86400_000).toISOString().slice(0, 10) : first;
      const txs = await eb.getTransactions(env, a.eb_account_uid, from);
      const stmts: D1PreparedStatement[] = [];
      for (const t of txs) {
        if (t.status && t.status !== 'BOOK') continue; // csak a könyvelt tételek
        const amt = Math.round(parseFloat(t.transaction_amount.amount)) * (t.credit_debit_indicator === 'DBIT' ? -1 : 1);
        const date = t.booking_date || t.value_date || t.transaction_date || todayHu();
        const partner = (t.credit_debit_indicator === 'CRDT' ? t.debtor?.name : t.creditor?.name) || '';
        const memo = [...(t.remittance_information || []), t.note || ''].filter(Boolean).join(' · ');
        const ext = t.entry_reference || t.transaction_id || `${date}|${amt}|${partner}|${memo}`;
        stmts.push(insertTxStmt(env, ctx, a.id, { ext, date, amount: Math.abs(amt) * Math.sign(amt), currency: t.transaction_amount.currency, partner, memo }));
      }
      if (bal)
        stmts.push(
          env.DB.prepare('UPDATE bank_accounts SET balance = ?, currency = ?, balance_at = ? WHERE id = ?').bind(bal.amount, bal.currency, now(), a.id),
        );
      stmts.push(env.DB.prepare('UPDATE bank_accounts SET last_sync = ?, last_error = NULL WHERE id = ?').bind(now(), a.id));
      for (let i = 0; i < stmts.length; i += 100) await env.DB.batch(stmts.slice(i, i + 100));
    } catch (e: any) {
      errors.push(`${a.bank_name}: ${e.message}`);
      await env.DB.prepare('UPDATE bank_accounts SET last_error = ?, last_sync = ? WHERE id = ?').bind(String(e.message).slice(0, 300), now(), a.id).run();
    }
  }
  const after = await env.DB.prepare("SELECT COUNT(*) AS n FROM bank_tx WHERE status = 'new'").first<{ n: number }>();
  await setSetting(env, 'bank_last_sync', String(now()));
  const auto = await autoApprove(env, approve);
  return { accounts: accts.results.length, newTx: (after?.n || 0) - (before?.n || 0), auto, errors };
}

/** A szabályok újraalkalmazása a jóváhagyásra váró tételekre (kategória), majd automatikus jóváhagyás. */
export async function reapplyRules(env: Env): Promise<{ updated: number; auto: number }> {
  const ctx = await matchingContext(env);
  const txs = await env.DB.prepare("SELECT id, date, amount, partner, memo, leaf_id FROM bank_tx WHERE status = 'new'").all<any>();
  const stmts: D1PreparedStatement[] = [];
  for (const t of txs.results) {
    const leaf = suggestLeaf(t, ctx.rules, ctx.leaves, ctx.sectionOf, ctx.contains);
    if (leaf && leaf !== t.leaf_id) stmts.push(env.DB.prepare('UPDATE bank_tx SET leaf_id = ? WHERE id = ?').bind(leaf, t.id));
  }
  for (let i = 0; i < stmts.length; i += 100) await env.DB.batch(stmts.slice(i, i + 100));
  return { updated: stmts.length, auto: await autoApprove(env, approve) };
}

/**
 * Banki díj felismerése: a bank a díjat (tranzakciós díj / illeték) külön terhelésként küldi, sokszor a fő utalás
 * kedvezményezettjének nevével és üres közleménnyel (pl. Rackforest 10 236 Ft + 26 Ft, NAV Áfa 399 000 + 998 Ft).
 * Díj az a kis terhelés, amely mellett ugyanazon a számlán, ±1 napon belül ugyanannak a partnernek ment egy legalább
 * százszor nagyobb utalás. Ezek a „Bank költség” alá kerülnek, jóváhagyás nélkül; a tévesen máshova jóváhagyottak átkerülnek.
 */
export async function markBankFees(env: Env): Promise<number> {
  const [txR, leafR] = await env.DB.batch([
    env.DB.prepare(
      "SELECT id, account_id, date, amount, partner, memo, status, leaf_id, actual_id FROM bank_tx WHERE amount < 0 AND date >= date('now', '-120 days')",
    ),
    env.DB.prepare("SELECT l.id, l.label FROM leaves l JOIN groups g ON g.id = l.group_id WHERE g.section = 'out' AND l.archived = 0"),
  ]);
  const fee = (leafR.results as any[]).find((l) => /^bank ?koltseg/.test(normalizeText(l.label)))?.id as string | undefined;
  if (!fee) return 0;
  const txs = txR.results as any[];
  const day = (d: string) => Date.parse(d + 'T00:00:00Z') / 86400_000;
  const byKey = new Map<string, any[]>();
  for (const t of txs) {
    const k = partnerKey(t.partner || '');
    if (k.length < 2) continue;
    (byKey.get(k) || byKey.set(k, []).get(k)!).push(t);
  }
  const isFee = (t: any) => {
    if (t.leaf_id === fee) return false;
    if (normalizeText(t.memo || '').startsWith('banki dij')) return true;
    if (Math.abs(t.amount) > 10000 || (t.memo || '').trim()) return false;
    const sib = byKey.get(partnerKey(t.partner || '')) || [];
    return sib.some(
      (m) => m.id !== t.id && m.account_id === t.account_id && Math.abs(day(m.date) - day(t.date)) <= 1 && Math.abs(m.amount) >= Math.abs(t.amount) * 100,
    );
  };
  const pending: ApproveItem[] = [];
  const moves: D1PreparedStatement[] = [];
  const t0 = now();
  for (const t of txs) {
    if (!isFee(t)) continue;
    if (t.status === 'new') pending.push({ id: t.id, leaf_id: fee, merge: true });
    else if (t.status === 'approved' && t.actual_id) {
      // tévesen máshova jóváhagyott díj: a tény átkerül a Bank költségbe, és leválik a tervről
      moves.push(env.DB.prepare('UPDATE entries SET leaf_id = ?, updated_at = ? WHERE id = ?').bind(fee, t0, t.actual_id));
      moves.push(env.DB.prepare('UPDATE entries SET done = 0, link_id = NULL, updated_at = ? WHERE kind = ? AND link_id = ?').bind(t0, 'plan', t.actual_id));
      moves.push(env.DB.prepare('UPDATE bank_tx SET leaf_id = ?, plan_id = NULL WHERE id = ?').bind(fee, t.id));
    }
  }
  if (moves.length) await env.DB.batch(moves);
  if (pending.length) await approve(env, null, pending);
  // a díjból tévesen indított havi sorozat (pl. „Szignetta 92 Ft havonta”) nyitott tervei törlődnek – a díj nem partner-tétel
  await env.DB.prepare(
    "DELETE FROM entries WHERE kind = 'plan' AND done = 0 AND leaf_id <> ? AND series_id IN (SELECT 's' || id FROM bank_tx WHERE leaf_id = ? AND amount < 0)",
  )
    .bind(fee, fee)
    .run();
  return pending.length + moves.length / 3;
}

/** Az ismétlődő tételek neve a hónappal (a szerveren létrejött sorozatokra is, pl. NAV-számlából rendszeres terv). */
const RECURRING_MONTH_SQL = `UPDATE entries
SET period = COALESCE(period, substr(date, 1, 7)),
    name = trim(name) || ' – ' || substr(COALESCE(period, date), 1, 4) || '. ' || CASE substr(COALESCE(period, date), 6, 2) WHEN '01' THEN 'január' WHEN '02' THEN 'február' WHEN '03' THEN 'március' WHEN '04' THEN 'április' WHEN '05' THEN 'május' WHEN '06' THEN 'június' WHEN '07' THEN 'július' WHEN '08' THEN 'augusztus' WHEN '09' THEN 'szeptember' WHEN '10' THEN 'október' WHEN '11' THEN 'november' ELSE 'december' END
WHERE kind = 'plan' AND trim(name) <> ''
  AND name NOT GLOB '*[12][0-9][0-9][0-9]. *'
  AND lower(trim(name)) NOT LIKE '%január' AND lower(trim(name)) NOT LIKE '%február' AND lower(trim(name)) NOT LIKE '%március' AND lower(trim(name)) NOT LIKE '%április' AND lower(trim(name)) NOT LIKE '%május' AND lower(trim(name)) NOT LIKE '%június' AND lower(trim(name)) NOT LIKE '%július' AND lower(trim(name)) NOT LIKE '%augusztus' AND lower(trim(name)) NOT LIKE '%szeptember' AND lower(trim(name)) NOT LIKE '%október' AND lower(trim(name)) NOT LIKE '%november' AND lower(trim(name)) NOT LIKE '%december'`;

/**
 * Terv ↔ tény összevonás: ha egy kategóriában a hónap nyitott terve és egy (tervhez nem kötött) tény összege
 * legfeljebb 200 Ft-tal (vagy 1%-kal) tér el, a tény a tervhez kötődik, a terv teljesül – nem marad két külön sor
 * (pl. Könyvelési díj 36 830 terv + 36 830 tény „terv nélkül”). A keret-terv (pl. Előre nem látható költség) kimarad.
 */
export async function linkSameMonthActuals(env: Env): Promise<number> {
  const [pR, aR, lR] = await env.DB.batch([
    env.DB.prepare(
      "SELECT id, leaf_id, date, period, amount, name FROM entries WHERE kind = 'plan' AND done = 0 AND COALESCE(tentative, 0) = 0 AND amount <> 0 AND date >= date('now', '-150 days') AND date <= date('now', '+40 days')",
    ),
    env.DB.prepare(
      `SELECT a.id, a.leaf_id, a.date, a.amount FROM entries a WHERE a.kind = 'actual' AND a.date >= date('now', '-150 days')
       AND NOT EXISTS (SELECT 1 FROM entries p WHERE p.kind = 'plan' AND p.link_id = a.id)`,
    ),
    env.DB.prepare('SELECT id, label FROM leaves'),
  ]);
  const label = new Map((lR.results as any[]).map((l) => [l.id as string, l.label as string]));
  const acts = aR.results as any[];
  const used = new Set<string>();
  const t = now();
  const stmts: D1PreparedStatement[] = [];
  for (const p of (pR.results as any[]).sort((a, b) => a.date.localeCompare(b.date))) {
    if (isBudgetPlan(p as Entry, label.get(p.leaf_id) || '')) continue;
    const ym = p.period || p.date.slice(0, 7);
    const tol = Math.max(200, Math.abs(p.amount) * 0.01);
    const hit = acts
      .filter((a) => !used.has(a.id) && a.leaf_id === p.leaf_id && Math.sign(a.amount) === Math.sign(p.amount) && Math.abs(a.amount - p.amount) <= tol)
      .filter((a) => a.date.slice(0, 7) === ym || Math.abs(Date.parse(a.date) - Date.parse(p.date)) <= 10 * 86400_000)
      .sort(
        (a, b) =>
          Math.abs(a.amount - p.amount) - Math.abs(b.amount - p.amount) ||
          Math.abs(Date.parse(a.date) - Date.parse(p.date)) - Math.abs(Date.parse(b.date) - Date.parse(p.date)),
      )[0];
    if (!hit) continue;
    used.add(hit.id);
    stmts.push(env.DB.prepare('UPDATE entries SET done = 1, link_id = ?, updated_at = ? WHERE id = ? AND done = 0').bind(hit.id, t, p.id));
  }
  for (let i = 0; i < stmts.length; i += 100) await env.DB.batch(stmts.slice(i, i + 100));
  return stmts.length;
}

/**
 * A NAV-számlából felvett terv már kifizetett tény, ha: van hozzá azonos összegű tény (→ összekötés), vagy egy várakozó /
 * kihagyott banki tétel (→ jóváhagyás a tervhez), különben ha kártyával / készpénzzel fizették, a terv lezárul (a vásárláskor
 * fizetve) – így nem marad „lejárt tervezett kiadás” (pl. SimplePay, Szilvási Trader kártyás vásárlás).
 */
export async function settleNavPlans(env: Env): Promise<number> {
  const [pR, aR, tR] = await env.DB.batch([
    env.DB.prepare(
      `SELECT p.id, p.leaf_id, p.amount, p.date, n.issue_date, n.payment_date, n.payment_method, n.partner_name FROM entries p
       JOIN nav_invoices n ON n.id = p.ext_ref OR n.plan_id = p.id
       WHERE p.kind = 'plan' AND p.done = 0 AND COALESCE(p.tentative, 0) = 0 AND p.date < date('now') AND p.date >= date('now', '-400 days')`,
    ),
    env.DB.prepare(
      `SELECT a.id, a.date, a.amount FROM entries a WHERE a.kind = 'actual' AND a.amount < 0 AND a.date >= date('now', '-420 days')
       AND NOT EXISTS (SELECT 1 FROM entries p WHERE p.kind = 'plan' AND p.link_id = a.id)`,
    ),
    env.DB.prepare(
      "SELECT id, date, amount, status, partner FROM bank_tx WHERE amount < 0 AND actual_id IS NULL AND status IN ('new', 'ignored') AND date >= date('now', '-420 days')",
    ),
  ]);
  const acts = aR.results as any[];
  const txs = tR.results as any[];
  const usedA = new Set<string>(),
    usedT = new Set<string>();
  const t0 = now();
  const stmts: D1PreparedStatement[] = [];
  const items: ApproveItem[] = [];
  const seen = new Set<string>();
  for (const p of pR.results as any[]) {
    if (seen.has(p.id)) continue;
    seen.add(p.id);
    const from = p.issue_date || p.date;
    const inWin = (d: string) => d >= addDaysIso(from, -5) && d <= addDaysIso(p.payment_date || p.date, 60);
    const a = acts.find((x) => !usedA.has(x.id) && Math.abs(x.amount - p.amount) < 1 && inWin(x.date));
    if (a) {
      usedA.add(a.id);
      stmts.push(env.DB.prepare('UPDATE entries SET done = 1, link_id = ?, updated_at = ? WHERE id = ? AND done = 0').bind(a.id, t0, p.id));
      continue;
    }
    const tx = txs.find((x) => !usedT.has(x.id) && Math.abs(x.amount - p.amount) < 1 && inWin(x.date));
    if (tx) {
      usedT.add(tx.id);
      if (tx.status === 'ignored') stmts.push(env.DB.prepare("UPDATE bank_tx SET status = 'new' WHERE id = ? AND status = 'ignored'").bind(tx.id));
      items.push({ id: tx.id, leaf_id: p.leaf_id, plan_id: p.id });
      continue;
    }
    // kártyás / készpénzes számla: a vásárláskor kifizetve (a bankban más összeggel / devizában jelenhet meg)
    if (/^(CARD|CASH)$/i.test(p.payment_method || ''))
      stmts.push(
        env.DB.prepare(
          "UPDATE entries SET done = 1, note = COALESCE(note, 'NAV: kártyával / készpénzzel fizetve'), updated_at = ? WHERE id = ? AND done = 0",
        ).bind(t0, p.id),
      );
  }
  for (let i = 0; i < stmts.length; i += 100) await env.DB.batch(stmts.slice(i, i + 100));
  if (items.length) await approve(env, null, items);
  return stmts.length + items.length;
}

const addDaysIso = (d: string, n: number) => new Date(Date.parse(d + 'T00:00:00Z') + n * 86400_000).toISOString().slice(0, 10);

export async function syncAll(env: Env) {
  const res: Record<string, unknown> = {};
  // partnertörzs adószámai a már meglévő NAV/Billingo adatokból (a szinkron párosítása így már adószám alapján megy)
  res.taxFilled = await fillPartnerTax(env).catch((e) => String(e?.message || e));
  if (env.BILLINGO_API_KEY) {
    try {
      res.billingo = await syncBillingo(env);
    } catch (e: any) {
      res.billingoError = e.message;
    }
  }
  if (env.EB_APP_ID && env.EB_PRIVATE_KEY) {
    try {
      res.bank = await syncBanks(env);
    } catch (e: any) {
      res.bankError = e.message;
    }
  }
  if (navEnabled(env)) {
    try {
      res.nav = await syncNav(env);
    } catch (e: any) {
      res.navError = e.message;
    }
  }
  try {
    res.bankFees = await markBankFees(env);
  } catch (e: any) {
    res.bankFeesError = e.message;
  }
  try {
    // kézi kivonatnál is: a várakozó tételekre az automatikus szabályok (pl. banki díjak)
    res.auto = await autoApprove(env, approve);
  } catch (e: any) {
    res.autoError = e.message;
  }
  try {
    // ÁFA-terv a friss bevételekből (következő hónapban fizetendő, 27/127)
    res.vat = await refreshVatPlans(env);
  } catch (e: any) {
    res.vatError = e.message;
  }
  try {
    // a friss számlákból újabb adószámok → a terv nélküli NAV-számlák újrapárosítása
    const more = await fillPartnerTax(env);
    if (more) await rematchNav(env);
    res.taxFilled2 = more;
    // az azonos adószámú NAV/Billingo cégnevek → a partner alternatív nevei (névösszevonás)
    const names = await mergePartnerNames(env);
    if (names) await reapplyRules(env).catch(() => null);
    res.namesMerged = names;
  } catch (e: any) {
    res.taxError = e.message;
  }
  try {
    res.billingoPaid = await payBillingoFromBank(env);
  } catch (e: any) {
    res.billingoPaidError = e.message;
  }
  try {
    // a terv nélkül létrejött számla-sorok összevonása a később felvett / elfogadott saját tervvel
    // kiszámlázott ügyfél = projekt: az ajánlat-mappából a számlás tételek a projekt-sorba
    res.invoicePlansMerged = await reconcileInvoicePlans(env);
    res.offersPromoted = await promoteOfferLeaves(env);
    res.partnerKinds = await fillPartnerKind(env);
    res.namesMerged2 = await mergePartnerNames(env);
  } catch (e: any) {
    res.invoicePlansError = e.message;
  }
  try {
    res.navSettled = await settleNavPlans(env);
  } catch (e: any) {
    res.navSettledError = e.message;
  }
  try {
    res.linkedSameMonth = await linkSameMonthActuals(env);
  } catch (e: any) {
    res.linkedSameMonthError = e.message;
  }
  try {
    // csak a tegnap óta módosult tervekre (a teljes tábla végigolvasása drága a D1 napi olvasási keretéhez képest)
    // csak a mostani időszak tervei (a dátum-indexen – a teljes tábla végigolvasása drága a D1 napi olvasási keretéhez képest)
    res.monthNames =
      (
        await env.DB.prepare(
          RECURRING_MONTH_SQL.replace("WHERE kind = 'plan'", "WHERE date >= date('now', '-45 days') AND date <= date('now', '+400 days') AND kind = 'plan'"),
        ).run()
      ).meta?.changes ?? 0;
  } catch (e: any) {
    res.monthNamesError = e.message;
  }
  try {
    res.leafFixed = await fixLinkedLeaves(env);
  } catch (e: any) {
    res.leafFixError = e.message;
  }
  return res;
}

/**
 * A Billingo-számlából jött terv és a hozzá kötött tény ugyanannál a partnernél legyen: ha a tény (pl. xls import,
 * banki tétel) más alkategóriában van, átkerül a terv partneréhez (a banki tétel is) – így a partner összesítője stimmel.
 */
export async function fixLinkedLeaves(env: Env): Promise<number> {
  const r = await env.DB.prepare(
    `SELECT a.id AS aid, p.leaf_id AS leaf FROM entries p JOIN entries a ON a.id = p.link_id
     WHERE p.kind = 'plan' AND a.kind = 'actual' AND a.leaf_id <> p.leaf_id`,
  ).all<{ aid: string; leaf: string }>();
  if (!r.results.length) return 0;
  const t = now();
  await env.DB.batch(
    r.results.flatMap((x) => [
      env.DB.prepare('UPDATE entries SET leaf_id = ?, updated_at = ? WHERE id = ?').bind(x.leaf, t, x.aid),
      env.DB.prepare('UPDATE bank_tx SET leaf_id = ? WHERE actual_id = ?').bind(x.leaf, x.aid),
    ]),
  );
  return r.results.length;
}

/** Banki jóváírás → Billingo-számla fizetettre állítása; ha volt ilyen, a tervek is frissülnek (terv lezárva, tény a banki tételhez kötve). */
export async function payBillingoFromBank(env: Env) {
  // banki díjak (a fő utalás mellett külön terhelés) előbb a helyükre, hogy ne párosodjanak számlához / tervhez
  await markBankFees(env).catch((e) => console.error('bank fees', e));
  const r = await autoPayBillingo(env);
  if (r.paid) {
    await syncBillingo(env).catch((e) => console.error('billingo sync after autopay', e));
    await autoApprove(env, approve).catch(() => 0);
  }
  const approved = await approveBillingoPaid(env).catch((e) => (console.error('billingo paid approve', e), 0));
  const byInvoice = await approveByInvoice(env).catch((e) => (console.error('invoice approve', e), 0));
  return { ...r, approved, byInvoice };
}

/**
 * Banki tétel → tény jóváhagyás nélkül, ha a partner számlája megvan, és a tervhez kötött számla a tételhez azonosítható:
 *  - a számla sorszáma a közleményben (ilyenkor eltérő összeggel is – az eltérést a riasztás jelzi: kevesebbet / többet utalt),
 *  - vagy forintra azonos összeg + a partner neve (cégnév, alternatív név) egyezik, a számla kelte után 60 napon belül.
 * Bevételnél a Billingo-, kiadásnál a NAV-számla számít; a tény a számla tervéhez kötődik.
 */
export async function approveByInvoice(env: Env): Promise<number> {
  const [docR, navR, txR, partnersR, leavesR] = await env.DB.batch([
    env.DB.prepare(
      `SELECT d.number, d.partner AS name, d.gross, d.invoice_date AS issued, p.id AS plan_id, p.leaf_id FROM billingo_docs d JOIN entries p ON p.id = d.plan_id
       WHERE d.cancelled = 0 AND p.kind = 'plan' AND p.done = 0 AND d.invoice_date >= date('now', '-200 days')`,
    ),
    env.DB.prepare(
      `SELECT n.invoice_number AS number, n.partner_name AS name, -abs(n.gross) AS gross, n.issue_date AS issued, p.id AS plan_id, p.leaf_id FROM nav_invoices n
       JOIN entries p ON p.id = n.plan_id WHERE p.kind = 'plan' AND p.done = 0 AND n.issue_date >= date('now', '-200 days')`,
    ),
    env.DB.prepare("SELECT id, date, amount, partner, memo FROM bank_tx WHERE status = 'new' AND actual_id IS NULL"),
    env.DB.prepare('SELECT key, name, aliases FROM partners'),
    env.DB.prepare('SELECT id, label FROM leaves'),
  ]);
  const invs = [...(docR.results as any[]), ...(navR.results as any[])];
  const txs = txR.results as { id: string; date: string; amount: number; partner: string; memo: string }[];
  if (!invs.length || !txs.length) return 0;
  const label = new Map((leavesR.results as any[]).map((l) => [l.id as string, l.label as string]));
  const reg = new Map((partnersR.results as any[]).map((p) => [p.key as string, [p.name, ...JSON.parse(p.aliases || '[]')] as string[]]));
  const namesOf = (inv: any): string[] => {
    const lab = label.get(inv.leaf_id) || '';
    return [inv.name, lab, ...(reg.get(partnerKey(lab).replace(/[^a-z0-9]/g, '')) || [])].filter(Boolean);
  };
  const squash = (x: string) => normalizeText(x).replace(/[^a-z0-9]/g, '');
  const items: ApproveItem[] = [];
  const usedPlan = new Set<string>();
  for (const tx of [...txs].sort((a, b) => a.date.localeCompare(b.date))) {
    const text = squash(`${tx.partner} ${tx.memo}`);
    const same = invs.filter((i) => !usedPlan.has(i.plan_id) && Math.sign(i.gross) === Math.sign(tx.amount));
    const byNumber = same.find((i) => {
      const n = squash(String(i.number || ''));
      return n.length >= 5 && text.includes(n);
    });
    const byAmount =
      byNumber ||
      same.find(
        (i) =>
          Math.abs(i.gross - tx.amount) < 1 &&
          (!i.issued || (tx.date >= i.issued && Date.parse(tx.date) - Date.parse(i.issued) <= 60 * 86400_000)) &&
          !!tx.partner &&
          namesOf(i).some((n) => namesMatch(n, tx.partner)),
      );
    if (!byAmount) continue;
    usedPlan.add(byAmount.plan_id);
    items.push({ id: tx.id, leaf_id: byAmount.leaf_id, plan_id: byAmount.plan_id });
  }
  if (items.length) await approve(env, null, items);
  return items.length;
}

/**
 * A Billingo-számla kifizetését jelentő banki jóváírás magától jóváhagyva: a tény a számla tervéhez kötődik
 * (a terv összege nem változik). Két eset: 1) a program párosította a számlával (paid_by_tx); 2) a számla a Billingóban
 * már fizetett, és a jóváírás forintra egyezik vele, a számla sorszáma a közleményben van, vagy a partner (név / alternatív név) egyezik.
 */
export async function approveBillingoPaid(env: Env): Promise<number> {
  const [paidR, txR, partnersR] = await env.DB.batch([
    env.DB.prepare(
      `SELECT d.id, d.number, d.partner, d.gross, d.paid_by_tx, d.paid_date, COALESCE(p.leaf_id, a.leaf_id) AS leaf_id, a.id AS actual_id, a.source AS actual_source
       FROM billingo_docs d
       LEFT JOIN entries p ON p.id = d.plan_id
       LEFT JOIN entries a ON a.ext_ref = 'bpaid:' || d.id OR a.id = p.link_id
       WHERE d.cancelled = 0 AND d.payment_status = 'paid' AND d.paid_date >= date('now', '-120 days')`,
    ),
    env.DB.prepare("SELECT id, date, amount, partner, memo FROM bank_tx WHERE status = 'new' AND amount > 0"),
    env.DB.prepare('SELECT name, aliases FROM partners'),
  ]);
  const docs = paidR.results as any[];
  const txs = txR.results as { id: string; date: string; amount: number; partner: string; memo: string }[];
  if (!docs.length || !txs.length) return 0;
  const groups = (partnersR.results as any[]).map((p) => [p.name, ...JSON.parse(p.aliases || '[]')] as string[]);
  const aliasesOf = (name: string) => groups.find((g) => g.some((n) => namesMatch(n, name))) || [name];
  const items: ApproveItem[] = [];
  const usedDoc = new Set<number>();
  for (const tx of txs) {
    const text = normalizeText(`${tx.partner} ${tx.memo}`).replace(/[^a-z0-9]/g, '');
    const doc =
      docs.find((d) => !usedDoc.has(d.id) && d.paid_by_tx === tx.id) ||
      docs.find((d) => {
        if (usedDoc.has(d.id) || d.paid_by_tx || !d.leaf_id || Math.round(d.gross) !== Math.round(tx.amount)) return false;
        if (d.paid_date && Math.abs(Date.parse(d.paid_date) - Date.parse(tx.date)) > 20 * 86400_000) return false;
        const num = normalizeText(String(d.number || '')).replace(/[^a-z0-9]/g, '');
        if (num.length >= 5 && text.includes(num)) return true;
        return !!tx.partner && aliasesOf(String(d.partner || '')).some((n) => namesMatch(n, tx.partner));
      });
    // csak ha a fizetett számlából már tény lett (azt kapja meg a banki tétel); kézi tényhez nem kötünk automatikusan
    if (!doc?.leaf_id || doc.actual_source !== 'billingo') continue;
    usedDoc.add(doc.id);
    items.push({ id: tx.id, leaf_id: doc.leaf_id });
  }
  if (items.length) await approve(env, null, items);
  return items.length;
}

export interface ApproveItem {
  id: string;
  leaf_id?: string | null;
  plan_id?: string | null;
  name?: string;
  rep?: 'once' | 'monthly' | 'quarterly' | 'yearly';
  count?: number;
  /** havonta + bankonként egy összevont tényben (pl. banki díjak) */
  merge?: boolean;
}

/** „Előre nem látható költség” alkategória – az új, tervhez nem köthető kiadások alapértelmezése. */
async function unforeseenLeaf(env: Env): Promise<string | null> {
  const r = await env.DB.prepare("SELECT l.id, l.label FROM leaves l JOIN groups g ON g.id = l.group_id WHERE g.section = 'out' AND l.archived = 0").all<{
    id: string;
    label: string;
  }>();
  return r.results.find((l) => normalizeText(l.label).startsWith('elore nem lathato'))?.id ?? null;
}

const addMonthsDate = (date: string, n: number) => {
  const [y, m, d] = date.split('-').map(Number);
  const t = y * 12 + (m - 1) + n;
  const ny = Math.floor(t / 12),
    nm = (t % 12) + 1;
  const last = new Date(Date.UTC(ny, nm, 0)).getUTCDate();
  return `${ny}-${String(nm).padStart(2, '0')}-${String(Math.min(d, last)).padStart(2, '0')}`;
};

export async function approve(env: Env, userId: number | null, items: ApproveItem[]) {
  const stmts: D1PreparedStatement[] = [];
  const t = now();
  const unforeseen = await unforeseenLeaf(env);
  const mergedSeen = new Set<string>();
  for (const it of items) {
    const tx = await env.DB.prepare("SELECT * FROM bank_tx WHERE id = ? AND status = 'new'").bind(String(it.id)).first<any>();
    if (!tx) continue;
    const leafId = it.leaf_id || tx.leaf_id || (tx.amount < 0 ? unforeseen : null);
    if (!leafId) throw new HttpError(400, `Válassz kategóriát: ${tx.partner || tx.memo}`);
    const leafRow = await env.DB.prepare('SELECT id, label FROM leaves WHERE id = ?').bind(leafId).first<{ id: string; label: string }>();
    if (!leafRow) throw new HttpError(400, 'Ismeretlen kategória.');
    if (it.merge) {
      // Összevonás: dátum (hónap) + bank + kategória → egyetlen tény, a hónap legutolsó tételének dátumával
      const ym = String(tx.date).slice(0, 7);
      const mid = `m_${leafId}_${tx.account_id}_${ym}`.replace(/[^\w-]/g, '_');
      const acc = await env.DB.prepare('SELECT bank_name FROM bank_accounts WHERE id = ?').bind(tx.account_id).first<{ bank_name: string }>();
      let planId: string | null = null;
      if (!mergedSeen.has(mid)) {
        mergedSeen.add(mid);
        const exists = await env.DB.prepare('SELECT id FROM entries WHERE id = ?').bind(mid).first();
        if (!exists) {
          // az adott havi terv (pl. Bankköltség) lezárása
          const p = await env.DB.prepare(
            "SELECT id FROM entries WHERE kind = 'plan' AND done = 0 AND leaf_id = ? AND substr(date, 1, 7) = ? ORDER BY date LIMIT 1",
          )
            .bind(leafId, ym)
            .first<{ id: string }>();
          planId = p?.id ?? null;
        }
      }
      stmts.push(
        env.DB.prepare(
          `INSERT INTO entries (id, kind, date, leaf_id, name, amount, done, tentative, source, ext_ref, link_id, note, updated_at, updated_by)
           VALUES (?, 'actual', ?, ?, ?, ?, 0, 0, 'bank', ?, ?, 'összevont banki tételek', ?, ?)
           ON CONFLICT(id) DO UPDATE SET amount = entries.amount + excluded.amount, date = MAX(entries.date, excluded.date),
             updated_at = excluded.updated_at`,
        ).bind(
          mid,
          tx.date,
          leafId,
          `${leafRow.label} · ${acc?.bank_name || 'bank'} · ${ym.replace('-', '. ')}. (összevont)`,
          tx.amount,
          'merge:' + mid,
          planId,
          t,
          userId,
        ),
      );
      if (planId) stmts.push(env.DB.prepare('UPDATE entries SET done = 1, link_id = ?, updated_at = ? WHERE id = ?').bind(mid, t, planId));
      stmts.push(env.DB.prepare("UPDATE bank_tx SET status = 'approved', actual_id = ?, leaf_id = ?, plan_id = NULL WHERE id = ?").bind(mid, leafId, tx.id));
      continue;
    }
    let planId: string | null = 'plan_id' in it ? it.plan_id || null : tx.plan_id;
    if (planId && !('plan_id' in it)) {
      // nem kifejezetten választott (javasolt / automatikus) terv csak azonos kategóriában és hasonló összegnél zárható le
      const p = await env.DB.prepare('SELECT leaf_id, amount, done FROM entries WHERE id = ?')
        .bind(planId)
        .first<{ leaf_id: string; amount: number; done: number }>();
      if (!p || p.done || p.leaf_id !== leafId || Math.abs(tx.amount) < Math.abs(p.amount) * 0.3) planId = null;
    }
    // a Billingo szerint már kifizetett számlából lett tény: a banki tétel ahhoz kapcsolódik (nincs dupla bevétel)
    if (tx.amount > 0) {
      const bp = await env.DB.prepare(
        "SELECT id FROM entries WHERE kind = 'actual' AND ext_ref LIKE 'bpaid:%' AND abs(amount - ?) <= max(500, abs(?) * 0.01) AND abs(julianday(date) - julianday(?)) <= 20 ORDER BY abs(julianday(date) - julianday(?)) LIMIT 1",
      )
        .bind(tx.amount, tx.amount, tx.date, tx.date)
        .first<{ id: string }>();
      if (bp) {
        stmts.push(
          env.DB.prepare("UPDATE entries SET source = 'bank', ext_ref = ?, date = ?, updated_at = ?, updated_by = ? WHERE id = ?").bind(
            'bank:' + tx.id,
            tx.date,
            t,
            userId,
            bp.id,
          ),
          env.DB.prepare("UPDATE bank_tx SET status = 'approved', actual_id = ?, leaf_id = ? WHERE id = ?").bind(bp.id, leafId, tx.id),
        );
        continue;
      }
    }
    const actualId = 'a' + tx.id;
    const name = (String(it.name || '').trim() || tx.partner || tx.memo || 'Banki tétel').slice(0, 200);
    const rep = it.rep === 'monthly' || it.rep === 'quarterly' || it.rep === 'yearly' ? it.rep : null;
    const sid = rep ? 's' + tx.id : null;
    // a tény mindig a banki könyvelés napjára kerül
    stmts.push(
      env.DB.prepare(
        `INSERT INTO entries (id, kind, date, leaf_id, name, amount, series_id, done, tentative, source, ext_ref, link_id, note, updated_at, updated_by)
         VALUES (?, 'actual', ?, ?, ?, ?, ?, 0, 0, 'bank', ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING`,
      ).bind(actualId, tx.date, leafId, name, tx.amount, sid, 'bank:' + tx.id, planId, tx.memo || null, t, userId),
    );
    if (planId)
      stmts.push(env.DB.prepare('UPDATE entries SET done = 1, link_id = ?, updated_at = ?, updated_by = ? WHERE id = ?').bind(actualId, t, userId, planId));
    if (rep && sid) {
      // ismétlődő: a következő hónaptól tervezett tételek ugyanazzal az összeggel és nappal
      const step = rep === 'yearly' ? 12 : rep === 'quarterly' ? 3 : 1;
      const pr = await env.DB.prepare('SELECT l.pay_rule AS lp, g.pay_rule AS gp FROM leaves l JOIN groups g ON g.id = l.group_id WHERE l.id = ?')
        .bind(leafId)
        .first<{ lp: string | null; gp: string | null }>();
      const rule = pr?.lp || pr?.gp || null;
      const nextDate = (i: number) =>
        rule ? payDate(addMonthsDate(tx.date, i * step).slice(0, 7), rule, Number(tx.date.slice(8))) : addMonthsDate(tx.date, i * step);
      const n = Math.ceil(Math.min(36, Math.max(1, Number(it.count) || 12)) / step);
      stmts.push(
        env.DB.prepare('INSERT OR REPLACE INTO series (id, leaf_id, name, rep, day) VALUES (?, ?, ?, ?, ?)').bind(
          sid,
          leafId,
          name,
          rep,
          Number(tx.date.slice(8)),
        ),
      );
      for (let i = 1; i <= n; i++)
        stmts.push(
          env.DB.prepare(
            `INSERT INTO entries (id, kind, date, leaf_id, name, amount, series_id, done, tentative, source, updated_at, updated_by)
             VALUES (?, 'plan', ?, ?, ?, ?, ?, 0, 0, 'manual', ?, ?) ON CONFLICT DO NOTHING`,
          ).bind(`r${tx.id}_${i}`, nextDate(i), leafId, name, tx.amount, sid, t, userId),
        );
    }
    stmts.push(
      env.DB.prepare("UPDATE bank_tx SET status = 'approved', actual_id = ?, leaf_id = ?, plan_id = ? WHERE id = ?").bind(actualId, leafId, planId, tx.id),
    );
    const key = partnerKey(tx.partner || '');
    if (key)
      stmts.push(
        env.DB.prepare(
          'INSERT INTO partner_rules (pattern, leaf_id, hits, updated_at) VALUES (?, ?, 1, ?) ON CONFLICT(pattern) DO UPDATE SET leaf_id = excluded.leaf_id, hits = partner_rules.hits + 1, updated_at = excluded.updated_at',
        ).bind(key, leafId, t),
      );
  }
  for (let i = 0; i < stmts.length; i += 100) await env.DB.batch(stmts.slice(i, i + 100));
  await audit(env, userId, userId ? 'bank_approve' : 'bank_auto_approve', { n: items.length });
  // a kifizetett NAV-számlák (terv nélküliek) a banki ténnyel párosulnak
  await rematchNav(env).catch((e) => console.error('nav rematch', e));
}

async function unapprove(env: Env, u: User, ids: string[]) {
  for (const id of ids) {
    const tx = await env.DB.prepare("SELECT * FROM bank_tx WHERE id = ? AND status = 'approved'").bind(id).first<any>();
    if (!tx) continue;
    if (String(tx.actual_id || '').startsWith('m_')) {
      // összevont tényből kivonjuk; ha kiürül, törlődik és a terv újra nyitott lesz
      await env.DB.batch([
        env.DB.prepare('UPDATE entries SET amount = amount - ? WHERE id = ?').bind(tx.amount, tx.actual_id),
        env.DB.prepare(
          "UPDATE entries SET done = 0, link_id = NULL WHERE kind = 'plan' AND link_id = ? AND EXISTS (SELECT 1 FROM entries WHERE id = ? AND amount = 0)",
        ).bind(tx.actual_id, tx.actual_id),
        env.DB.prepare('DELETE FROM entries WHERE id = ? AND amount = 0').bind(tx.actual_id),
        env.DB.prepare("UPDATE bank_tx SET status = 'new', actual_id = NULL WHERE id = ?").bind(tx.id),
      ]);
      continue;
    }
    await env.DB.batch([
      env.DB.prepare('DELETE FROM entries WHERE id = ?').bind(tx.actual_id),
      env.DB.prepare('UPDATE entries SET done = 0, link_id = NULL WHERE id = ? AND link_id = ?').bind(tx.plan_id, tx.actual_id),
      env.DB.prepare("UPDATE bank_tx SET status = 'new', actual_id = NULL WHERE id = ?").bind(tx.id),
      // a jóváhagyáskor létrehozott ismétlődő tervek (amelyek még nyitottak) is visszavonódnak
      env.DB.prepare("DELETE FROM entries WHERE series_id = ? AND kind = 'plan' AND done = 0").bind('s' + tx.id),
      env.DB.prepare('DELETE FROM series WHERE id = ?').bind('s' + tx.id),
    ]);
  }
  await audit(env, u.id, 'bank_unapprove', { n: ids.length });
}

export async function handleBank(env: Env, req: Request, path: string, u: User, url: URL): Promise<Response | null> {
  const bdoc = path.match(/^\/api\/billingo\/doc\/(\d{1,15})\/url$/);
  if (bdoc && req.method === 'GET') {
    // Billingo számlakép egy kattintással (nyilvános, időkorlátos link a Billingótól)
    return json({ url: await billingoPublicUrl(env, Number(bdoc[1])) });
  }
  if (path === '/api/billingo/promote' && req.method === 'POST') {
    // a kiszámlázott ajánlatok azonnal projektbe (különben a következő szinkronnál)
    requireRole(u, 'admin', 'member');
    await reconcileInvoicePlans(env);
    const n = await promoteOfferLeaves(env);
    await fillPartnerKind(env);
    await mergePartnerNames(env);
    return json({ ok: true, moved: n });
  }
  if (path === '/api/billingo/attach' && req.method === 'POST') {
    // kézi összevonás: a számlából létrejött külön sor a partner kiválasztott saját tervéhez kerül
    requireRole(u, 'admin', 'member');
    const b = await readJson<{ id: string; plan_id: string }>(req);
    const bill = await env.DB.prepare(
      "SELECT id, ext_ref, amount, bill_amount, date, done, link_id FROM entries WHERE id = ? AND kind = 'plan' AND ext_ref LIKE 'billingo:%' AND plan_amount IS NULL",
    )
      .bind(String(b.id || ''))
      .first<any>();
    if (!bill) throw new HttpError(404, 'Ismeretlen számla-sor.');
    const plan = await env.DB.prepare("SELECT id FROM entries WHERE id = ? AND kind = 'plan' AND done = 0 AND (ext_ref IS NULL OR ext_ref LIKE 'imp:%')")
      .bind(String(b.plan_id || ''))
      .first();
    if (!plan) throw new HttpError(400, 'A terv már le van zárva, vagy másik számlához tartozik.');
    await env.DB.batch(attachInvoiceStmts(env, bill, String(b.plan_id), now()));
    await promoteOfferLeaves(env);
    await fixLinkedLeaves(env);
    await audit(env, u.id, 'billingo_attach', { id: bill.id, plan: b.plan_id });
    return json({ ok: true });
  }
  if (path === '/api/nav/invoice' && req.method === 'GET') {
    // egy bejövő számla teljes tartalma a NAV-ból (tételsorokkal) – a riasztásoknál a sorszámra kattintva
    const n = String(url.searchParams.get('n') || '').slice(0, 60);
    if (!n) throw new HttpError(400, 'Hiányzó számlaszám.');
    const row = await env.DB.prepare('SELECT partner_tax FROM nav_invoices WHERE invoice_number = ? LIMIT 1').bind(n).first<{ partner_tax: string | null }>();
    if (!row) throw new HttpError(404, 'Ismeretlen számla.');
    return json(await fetchInvoiceData(env, n, row.partner_tax || ''));
  }
  if (path === '/api/nav/resolve' && req.method === 'POST') {
    // NAV-számla terv nélkül: havonta tervbe / előre nem látható költség / nem kell terv
    requireRole(u, 'admin', 'member');
    const b = await readJson<NavResolve>(req);
    if (!['recurring', 'unforeseen', 'assign', 'move', 'ignore', 'reopen'].includes(b.action)) throw new HttpError(400, 'Hibás művelet.');
    await resolveNav(env, u.id, b);
    return json({ ok: true });
  }
  if (path === '/api/nav/sync' && req.method === 'POST') {
    requireRole(u, 'admin');
    if (!navEnabled(env)) throw new HttpError(400, 'Nincs beállítva NAV kapcsolat (Cloudflare titkok: NAV_LOGIN, NAV_PASSWORD, NAV_SIGN_KEY, NAV_TAX_NUMBER).');
    const b = await readJson<{ from?: string }>(req).catch(() => ({}) as { from?: string });
    const from = b.from && /^\d{4}-\d{2}-\d{2}$/.test(b.from) ? b.from : undefined;
    const r = await syncNav(env, { from }).catch((e: any) => {
      throw new HttpError(502, String(e?.message || e));
    });
    await audit(env, u.id, 'nav_sync', r);
    return json(r);
  }
  if (!path.startsWith('/api/bank') && path !== '/api/sync') return null;

  if (path === '/api/sync' && req.method === 'POST') {
    requireRole(u, 'admin', 'member');
    // a Mac-es aggreg8 bankszinkront is kéri (a Mac fél percen belül elindítja)
    await setSetting(env, 'ingest_request', JSON.stringify({ at: now(), by: u.email }));
    const r = await syncAll(env);
    await audit(env, u.id, 'sync', r);
    return json(r);
  }

  if (path === '/api/bank/aspsps' && req.method === 'GET') {
    requireRole(u, 'admin');
    return json(await eb.listAspsps(env));
  }

  if (path === '/api/bank/connect' && req.method === 'POST') {
    requireRole(u, 'admin');
    const b = await readJson(req);
    const bank = String(b.bank_name || '').slice(0, 100);
    if (!bank) throw new HttpError(400, 'Válassz bankot.');
    const state = randomId('s');
    await env.DB.prepare('DELETE FROM oauth_states WHERE created_at < ?')
      .bind(now() - 3600_000)
      .run();
    await env.DB.prepare('INSERT INTO oauth_states (state, bank_name, user_id, created_at) VALUES (?, ?, ?, ?)').bind(state, bank, u.id, now()).run();
    const days = Math.min(180, Math.max(1, Number(b.days) || 180));
    const r = await eb.startAuth(env, bank, state, `${url.origin}/api/bank/callback`, days, b.psu_type === 'personal' ? 'personal' : 'business');
    return json({ url: r.url });
  }

  if (path === '/api/bank/callback' && req.method === 'GET') {
    const state = url.searchParams.get('state') || '';
    const code = url.searchParams.get('code');
    const st = await env.DB.prepare('SELECT * FROM oauth_states WHERE state = ?').bind(state).first<any>();
    if (!st || st.user_id !== u.id || st.created_at < now() - 3600_000)
      return Response.redirect(`${url.origin}/?bank=error&msg=${encodeURIComponent('Lejárt vagy érvénytelen kérés.')}`, 302);
    await env.DB.prepare('DELETE FROM oauth_states WHERE state = ?').bind(state).run();
    if (!code)
      return Response.redirect(
        `${url.origin}/?bank=error&msg=${encodeURIComponent(url.searchParams.get('error_description') || url.searchParams.get('error') || 'A bank megszakította.')}`,
        302,
      );
    try {
      const s = await eb.createSession(env, code);
      for (const a of s.accounts) {
        const iban = a.account_id?.iban || a.account_id?.other?.identification || null;
        const existing = await env.DB.prepare('SELECT id FROM bank_accounts WHERE (iban = ? AND iban IS NOT NULL) OR eb_account_uid = ?')
          .bind(iban, a.uid)
          .first<{ id: string }>();
        if (existing) {
          await env.DB.prepare('UPDATE bank_accounts SET eb_account_uid = ?, eb_session_id = ?, valid_until = ?, active = 1, last_error = NULL WHERE id = ?')
            .bind(a.uid, s.session_id, s.access.valid_until, existing.id)
            .run();
        } else {
          await env.DB.prepare(
            'INSERT INTO bank_accounts (id, provider, bank_name, label, iban, currency, eb_account_uid, eb_session_id, valid_until) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
          )
            .bind(
              randomId('acc'),
              'enablebanking',
              st.bank_name,
              a.name || a.product || st.bank_name,
              iban,
              a.currency || 'HUF',
              a.uid,
              s.session_id,
              s.access.valid_until,
            )
            .run();
        }
      }
      await env.DB.prepare("UPDATE bank_accounts SET active = 0 WHERE provider = 'manual' AND lower(bank_name) LIKE ?")
        .bind(
          '%' +
            String(st.bank_name)
              .toLowerCase()
              .replace(/\s*bank$/, '')
              .slice(0, 6) +
            '%',
        )
        .run();
      await audit(env, u.id, 'bank_connected', { bank: st.bank_name, accounts: s.accounts.length });
      await syncBanks(env);
      return Response.redirect(`${url.origin}/?bank=ok`, 302);
    } catch (e: any) {
      return Response.redirect(`${url.origin}/?bank=error&msg=${encodeURIComponent(e.message)}`, 302);
    }
  }

  const am = path.match(/^\/api\/bank\/accounts\/([\w-]+)$/);
  if (am && req.method === 'PATCH') {
    requireRole(u, 'admin');
    const b = await readJson(req);
    if (b.label !== undefined) await env.DB.prepare('UPDATE bank_accounts SET label = ? WHERE id = ?').bind(String(b.label).slice(0, 80), am[1]).run();
    if (b.active !== undefined)
      await env.DB.prepare('UPDATE bank_accounts SET active = ? WHERE id = ?')
        .bind(b.active ? 1 : 0, am[1])
        .run();
    if (b.balance !== undefined)
      await env.DB.prepare("UPDATE bank_accounts SET balance = ?, balance_at = ? WHERE id = ? AND provider = 'manual'")
        .bind(b.balance === null ? null : parseAmount(b.balance), now(), am[1])
        .run();
    return json({ ok: true });
  }

  if (path === '/api/bank/approve' && req.method === 'POST') {
    requireRole(u, 'admin', 'member');
    const b = await readJson<{ ids?: string[]; items?: ApproveItem[] }>(req);
    const items = b.items || (b.ids || []).map((id) => ({ id }));
    await approve(env, u.id, items.slice(0, 500));
    // a terv nélkül jóváhagyott tény azonnal a hónap azonos összegű tervéhez kötődik (pl. Munkabér 300 000)
    await linkSameMonthActuals(env).catch(() => 0);
    return json({ ok: true });
  }
  if (path === '/api/bank/unapprove' && req.method === 'POST') {
    requireRole(u, 'admin', 'member');
    const b = await readJson<{ ids: string[] }>(req);
    await unapprove(env, u, (b.ids || []).slice(0, 500));
    return json({ ok: true });
  }
  if (path === '/api/bank/ignore' && req.method === 'POST') {
    requireRole(u, 'admin', 'member');
    const b = await readJson<{ ids: string[]; undo?: boolean }>(req);
    for (const id of (b.ids || []).slice(0, 500))
      await env.DB.prepare('UPDATE bank_tx SET status = ? WHERE id = ? AND status = ?')
        .bind(b.undo ? 'new' : 'ignored', id, b.undo ? 'ignored' : 'new')
        .run();
    return json({ ok: true });
  }
  const tm = path.match(/^\/api\/bank\/tx\/([\w-]+)$/);
  if (tm && req.method === 'PATCH') {
    requireRole(u, 'admin', 'member');
    const b = await readJson(req);
    if (b.leaf_id !== undefined) await env.DB.prepare('UPDATE bank_tx SET leaf_id = ? WHERE id = ?').bind(b.leaf_id, tm[1]).run();
    if (b.plan_id !== undefined) await env.DB.prepare('UPDATE bank_tx SET plan_id = ? WHERE id = ?').bind(b.plan_id, tm[1]).run();
    return json({ ok: true });
  }

  // Kézi kivonat import (ha a PSD2 kapcsolat nem elérhető az adott banknál)
  if (path === '/api/bank/import' && req.method === 'POST') {
    requireRole(u, 'admin', 'member');
    const b = await readJson<{ bank_name: string; label: string; balance?: string; rows: ImportRowIn[] }>(req, 10_000_000);
    return json(await importManualRows(env, u.id, b));
  }
  return null;
}

export type ImportRowIn = { date: unknown; amount: unknown; partner?: string; memo?: string; ext?: string };

/** Kivonat-tételek importja egy kézi (kivonatos) bankszámlára – duplikáció-szűréssel, tervpárosítással. */
export async function importManualRows(
  env: Env,
  userId: number,
  b: { bank_name: string; label: string; balance?: string; rows: ImportRowIn[]; iban?: string | null },
) {
  const bank = String(b.bank_name || '')
    .trim()
    .slice(0, 60);
  if (!bank) throw new HttpError(400, 'Add meg a bank nevét.');
  const label = String(b.label || bank).slice(0, 80);
  let acc = await env.DB.prepare("SELECT id FROM bank_accounts WHERE provider = 'manual' AND bank_name = ? AND label = ?")
    .bind(bank, label)
    .first<{ id: string }>();
  if (!acc) {
    acc = { id: randomId('acc') };
    await env.DB.prepare("INSERT INTO bank_accounts (id, provider, bank_name, label) VALUES (?, 'manual', ?, ?)").bind(acc.id, bank, label).run();
  }
  const ctx = await matchingContext(env);
  // A TÉNYEK importban már szereplő időszak tételei csak archívumba kerülnek (duplikáció-szűréshez).
  // Kivétel: az utolsó 45 nap olyan banki tételei, amelyeknek nincs párja a tények között (pl. még nem rögzített
  // befizetések) – ezek jóváhagyásra mennek, és párosulnak a nyitott tervekkel.
  const cut = await env.DB.prepare("SELECT MAX(date) AS d FROM entries WHERE kind = 'actual' AND source = 'import'").first<{ d: string | null }>();
  const cutoff = cut?.d || '';
  const recentFrom = cutoff ? new Date(Date.parse(cutoff) - 45 * 86400_000).toISOString().slice(0, 10) : '';
  const facts = cutoff
    ? (
        await env.DB.prepare("SELECT date, amount FROM entries WHERE kind = 'actual' AND date >= ?")
          .bind(new Date(Date.parse(recentFrom) - 8 * 86400_000).toISOString().slice(0, 10))
          .all<{ date: string; amount: number }>()
      ).results.map((f) => ({ ...f, used: false }))
    : [];
  const statusFor = (date: string, amount: number): 'new' | 'ignored' => {
    if (!cutoff || date > cutoff) return 'new';
    if (date < recentFrom) return 'ignored';
    const f = facts.find((x) => !x.used && x.amount === amount && Math.abs(Date.parse(x.date) - Date.parse(date)) <= 7 * 86400_000);
    if (f) {
      f.used = true;
      return 'ignored';
    }
    return 'new';
  };
  const count = () =>
    env.DB.prepare('SELECT status, COUNT(*) AS n FROM bank_tx WHERE account_id = ? GROUP BY status').bind(acc!.id).all<{ status: string; n: number }>();
  const before = Object.fromEntries((await count()).results.map((r) => [r.status, r.n]));
  const stmts: D1PreparedStatement[] = [];
  const seen: Record<string, number> = {};
  let n = 0;
  // tartalom szerinti duplikáció-szűrés: ugyanaz a tétel más formátumból (pl. CSV után aggreg8 XML) más azonosítóval jönne
  const inRows = (b.rows || []).slice(0, 30000);
  const dates = inRows.map((r) => parseDate(r.date)).filter(Boolean) as string[];
  const have: Record<string, number> = {};
  const haveExt = new Set<string>();
  if (dates.length) {
    const ex = await env.DB.prepare('SELECT date, amount, ext_id FROM bank_tx WHERE account_id = ? AND date >= ? AND date <= ?')
      .bind(
        acc.id,
        dates.reduce((a, d) => (d < a ? d : a)),
        dates.reduce((a, d) => (d > a ? d : a)),
      )
      .all<{ date: string; amount: number; ext_id: string }>();
    ex.results.forEach((t) => {
      haveExt.add(t.ext_id);
      have[`${t.date}|${t.amount}`] = (have[`${t.date}|${t.amount}`] || 0) + 1;
    });
  }
  for (const r of inRows) {
    const date = parseDate(r.date);
    const amount = parseAmount(r.amount);
    if (!date || !amount) continue;
    const partner = String(r.partner || '').trim();
    const memo = String(r.memo || '').trim();
    let ext = r.ext ? String(r.ext).slice(0, 200) : '';
    if (!ext) {
      const base = `${date}|${amount}|${partner}|${memo}`;
      seen[base] = (seen[base] || 0) + 1;
      ext = base + '|' + seen[base];
    }
    n++;
    if (haveExt.has(ext)) continue;
    const k = `${date}|${amount}`;
    if (have[k]) {
      have[k]--;
      continue;
    }
    stmts.push(insertTxStmt(env, ctx, acc.id, { ext, date, amount, currency: 'HUF', partner, memo }, statusFor(date, amount)));
  }
  if (b.balance !== undefined && b.balance !== null && String(b.balance).trim() !== '')
    stmts.push(env.DB.prepare('UPDATE bank_accounts SET balance = ?, balance_at = ? WHERE id = ?').bind(parseAmount(b.balance), now(), acc.id));
  stmts.push(env.DB.prepare('UPDATE bank_accounts SET last_sync = ? WHERE id = ?').bind(now(), acc.id));
  for (let i = 0; i < stmts.length; i += 100) await env.DB.batch(stmts.slice(i, i + 100));
  const after = Object.fromEntries((await count()).results.map((r) => [r.status, r.n]));
  const auto = await autoApprove(env, approve);
  const added = { inbox: (after.new || 0) - (before.new || 0) - auto, archived: (after.ignored || 0) - (before.ignored || 0), auto };
  await audit(env, userId, 'bank_csv_import', { bank, rows: n, ...added });
  if (b.iban) await env.DB.prepare('UPDATE bank_accounts SET iban = ? WHERE id = ? AND iban IS NULL').bind(b.iban, acc.id).run();
  return { ok: true, bank, rows: n, ...added, duplicates: n - added.inbox - added.archived, cutoff };
}
