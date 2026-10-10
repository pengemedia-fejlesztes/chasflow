// Bankkapcsolat (BiNX, Magnet … PSD2-n keresztül), banki tételek jóváhagyása, CSV import.
import { normalizeText, parseAmount, parseDate } from '../shared/categories';
import { matchPlan, partnerKey, suggestLeaf } from '../shared/match';
import { autoApprove, loadContains } from './rules';
import { payDate } from '../shared/workdays';
import type { Entry, Leaf } from '../shared/types';
import { requireRole, type User } from './auth';
import { billingoPublicUrl, invoiceRefs, syncBillingo } from './billingo';
import { navEnabled, navInvoiceRefs, rematchNav, resolveNav, syncNav, type NavResolve } from './nav';
import * as eb from './enablebanking';
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

export async function syncAll(env: Env) {
  const res: Record<string, unknown> = {};
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
    // kézi kivonatnál is: a várakozó tételekre az automatikus szabályok (pl. banki díjak)
    res.auto = await autoApprove(env, approve);
  } catch (e: any) {
    res.autoError = e.message;
  }
  return res;
}

export interface ApproveItem {
  id: string;
  leaf_id?: string | null;
  plan_id?: string | null;
  name?: string;
  rep?: 'once' | 'monthly' | 'quarterly';
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
    const actualId = 'a' + tx.id;
    const name = (String(it.name || '').trim() || tx.partner || tx.memo || 'Banki tétel').slice(0, 200);
    const rep = it.rep === 'monthly' || it.rep === 'quarterly' ? it.rep : null;
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
      const step = rep === 'quarterly' ? 3 : 1;
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
  if (path === '/api/nav/resolve' && req.method === 'POST') {
    // NAV-számla terv nélkül: havonta tervbe / előre nem látható költség / nem kell terv
    requireRole(u, 'admin', 'member');
    const b = await readJson<NavResolve>(req);
    if (!['recurring', 'unforeseen', 'ignore', 'reopen'].includes(b.action)) throw new HttpError(400, 'Hibás művelet.');
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
    const b = await readJson<{
      bank_name: string;
      label: string;
      balance?: string;
      rows: { date: unknown; amount: unknown; partner?: string; memo?: string; ext?: string }[];
    }>(req, 10_000_000);
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
    for (const r of (b.rows || []).slice(0, 30000)) {
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
      stmts.push(insertTxStmt(env, ctx, acc.id, { ext, date, amount, currency: 'HUF', partner, memo }, statusFor(date, amount)));
      n++;
    }
    if (b.balance !== undefined && b.balance !== null && String(b.balance).trim() !== '')
      stmts.push(env.DB.prepare('UPDATE bank_accounts SET balance = ?, balance_at = ? WHERE id = ?').bind(parseAmount(b.balance), now(), acc.id));
    stmts.push(env.DB.prepare('UPDATE bank_accounts SET last_sync = ? WHERE id = ?').bind(now(), acc.id));
    for (let i = 0; i < stmts.length; i += 100) await env.DB.batch(stmts.slice(i, i + 100));
    const after = Object.fromEntries((await count()).results.map((r) => [r.status, r.n]));
    const auto = await autoApprove(env, approve);
    const added = { inbox: (after.new || 0) - (before.new || 0) - auto, archived: (after.ignored || 0) - (before.ignored || 0), auto };
    await audit(env, u.id, 'bank_csv_import', { bank, rows: n, ...added });
    return json({ ok: true, rows: n, ...added, duplicates: n - added.inbox - added.archived, cutoff });
  }
  return null;
}
