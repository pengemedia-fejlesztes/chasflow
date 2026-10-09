// Bankkapcsolat (BiNX, Magnet … PSD2-n keresztül), banki tételek jóváhagyása, CSV import.
import { parseAmount, parseDate } from '../shared/categories';
import { matchPlan, partnerKey, suggestLeaf } from '../shared/match';
import type { Entry, Leaf } from '../shared/types';
import { requireRole, type User } from './auth';
import { invoiceRefs, syncBillingo } from './billingo';
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

async function matchingContext(env: Env) {
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
  (rulesR.results as any[]).forEach((r) => (rules[r.pattern] = r.leaf_id));
  return { leaves, sectionOf: (id: string) => sec[lg[id]] || 'out', rules, plans: plansR.results as unknown as Entry[], refs: await invoiceRefs(env) };
}

type Ctx = Awaited<ReturnType<typeof matchingContext>>;

function insertTxStmt(
  env: Env,
  ctx: Ctx,
  accountId: string,
  tx: { ext: string; date: string; amount: number; currency: string; partner: string; memo: string },
) {
  const leaf = suggestLeaf(tx, ctx.rules, ctx.leaves, ctx.sectionOf);
  const plan = matchPlan({ ...tx, leaf_id: leaf }, ctx.plans, ctx.refs);
  return env.DB.prepare(
    `INSERT INTO bank_tx (id, account_id, ext_id, date, amount, currency, partner, memo, status, leaf_id, plan_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'new', ?, ?, ?) ON CONFLICT(account_id, ext_id) DO NOTHING`,
  ).bind(
    randomId('t'),
    accountId,
    tx.ext,
    tx.date,
    tx.amount,
    tx.currency,
    tx.partner.slice(0, 200),
    tx.memo.slice(0, 500),
    leaf ?? (plan ? plan.leaf_id : null),
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

export async function syncBanks(env: Env): Promise<{ accounts: number; newTx: number; errors: string[] }> {
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
  return { accounts: accts.results.length, newTx: (after?.n || 0) - (before?.n || 0), errors };
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
  return res;
}

async function approve(env: Env, u: User, ids: string[]) {
  const stmts: D1PreparedStatement[] = [];
  const t = now();
  for (const id of ids) {
    const tx = await env.DB.prepare("SELECT * FROM bank_tx WHERE id = ? AND status = 'new'").bind(id).first<any>();
    if (!tx) continue;
    if (!tx.leaf_id) throw new HttpError(400, `Válassz kategóriát: ${tx.partner || tx.memo}`);
    const actualId = 'a' + tx.id;
    const name = (tx.partner || tx.memo || 'Banki tétel').slice(0, 200);
    stmts.push(
      env.DB.prepare(
        `INSERT INTO entries (id, kind, date, leaf_id, name, amount, done, tentative, source, ext_ref, link_id, note, updated_at, updated_by)
         VALUES (?, 'actual', ?, ?, ?, ?, 0, 0, 'bank', ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING`,
      ).bind(actualId, tx.date, tx.leaf_id, name, tx.amount, 'bank:' + tx.id, tx.plan_id, tx.memo || null, t, u.id),
    );
    if (tx.plan_id)
      stmts.push(env.DB.prepare('UPDATE entries SET done = 1, link_id = ?, updated_at = ?, updated_by = ? WHERE id = ?').bind(actualId, t, u.id, tx.plan_id));
    stmts.push(env.DB.prepare("UPDATE bank_tx SET status = 'approved', actual_id = ? WHERE id = ?").bind(actualId, tx.id));
    const key = partnerKey(tx.partner || '');
    if (key)
      stmts.push(
        env.DB.prepare(
          'INSERT INTO partner_rules (pattern, leaf_id, hits, updated_at) VALUES (?, ?, 1, ?) ON CONFLICT(pattern) DO UPDATE SET leaf_id = excluded.leaf_id, hits = partner_rules.hits + 1, updated_at = excluded.updated_at',
        ).bind(key, tx.leaf_id, t),
      );
  }
  for (let i = 0; i < stmts.length; i += 100) await env.DB.batch(stmts.slice(i, i + 100));
  await audit(env, u.id, 'bank_approve', { n: ids.length });
}

async function unapprove(env: Env, u: User, ids: string[]) {
  for (const id of ids) {
    const tx = await env.DB.prepare("SELECT * FROM bank_tx WHERE id = ? AND status = 'approved'").bind(id).first<any>();
    if (!tx) continue;
    await env.DB.batch([
      env.DB.prepare('DELETE FROM entries WHERE id = ?').bind(tx.actual_id),
      env.DB.prepare('UPDATE entries SET done = 0, link_id = NULL WHERE id = ? AND link_id = ?').bind(tx.plan_id, tx.actual_id),
      env.DB.prepare("UPDATE bank_tx SET status = 'new', actual_id = NULL WHERE id = ?").bind(tx.id),
    ]);
  }
  await audit(env, u.id, 'bank_unapprove', { n: ids.length });
}

export async function handleBank(env: Env, req: Request, path: string, u: User, url: URL): Promise<Response | null> {
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
    const b = await readJson<{ ids: string[] }>(req);
    await approve(env, u, (b.ids || []).slice(0, 500));
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
      rows: { date: unknown; amount: unknown; partner?: string; memo?: string }[];
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
    const stmts: D1PreparedStatement[] = [];
    const seen: Record<string, number> = {};
    let n = 0;
    for (const r of (b.rows || []).slice(0, 20000)) {
      const date = parseDate(r.date);
      const amount = parseAmount(r.amount);
      if (!date || !amount) continue;
      const partner = String(r.partner || '').trim();
      const memo = String(r.memo || '').trim();
      const base = `${date}|${amount}|${partner}|${memo}`;
      seen[base] = (seen[base] || 0) + 1;
      stmts.push(insertTxStmt(env, ctx, acc.id, { ext: base + '|' + seen[base], date, amount, currency: 'HUF', partner, memo }));
      n++;
    }
    if (b.balance !== undefined && String(b.balance).trim() !== '')
      stmts.push(env.DB.prepare('UPDATE bank_accounts SET balance = ?, balance_at = ? WHERE id = ?').bind(parseAmount(b.balance), now(), acc.id));
    stmts.push(env.DB.prepare('UPDATE bank_accounts SET last_sync = ? WHERE id = ?').bind(now(), acc.id));
    for (let i = 0; i < stmts.length; i += 100) await env.DB.batch(stmts.slice(i, i + 100));
    await audit(env, u.id, 'bank_csv_import', { bank, rows: n });
    return json({ ok: true, rows: n });
  }
  return null;
}
