// Automatikus párosítások: „tartalmazza” szabályok + tanult partner szabályok, automatikus jóváhagyással.
import { normalizeText } from '../shared/categories';
import { matchContains, partnerKey, seedContainsRules, type ContainsRule } from '../shared/match';
import type { Leaf } from '../shared/types';
import { requireRole, type User } from './auth';
import { Env, HttpError, audit, getSetting, json, now, randomId, readJson, setSetting } from './util';

async function sectionMap(env: Env) {
  const [leavesR, groupsR] = await env.DB.batch([env.DB.prepare('SELECT * FROM leaves'), env.DB.prepare('SELECT id, section FROM groups')]);
  const leaves = leavesR.results as unknown as Leaf[];
  const sec: Record<string, 'in' | 'out'> = {};
  (groupsR.results as any[]).forEach((g) => (sec[g.id] = g.section));
  const lg: Record<string, string> = {};
  leaves.forEach((l) => (lg[l.id] = l.group_id));
  return { leaves, sectionOf: (id: string) => sec[lg[id]] || 'out' };
}

/** A beépített szabályok egyszeri betöltése az adatbázisba (onnantól szerkeszthetők / törölhetők). */
export async function ensureSeeded(env: Env) {
  if (await getSetting(env, 'rules_seeded')) return;
  const { leaves, sectionOf } = await sectionMap(env);
  const seeds = seedContainsRules(leaves, sectionOf);
  if (!seeds.length) return; // még nincsenek kategóriák (import előtt)
  const t = now();
  await env.DB.batch(
    seeds.map((r) =>
      env.DB.prepare("INSERT INTO match_rules (id, pattern, leaf_id, auto, merge, note, source, updated_at) VALUES (?, ?, ?, ?, ?, ?, 'builtin', ?)").bind(
        randomId('r'),
        r.pattern,
        r.leaf_id,
        r.auto,
        r.auto, // a beépített automatikus szabályok (banki díjak) havonta, bankonként összevonva
        r.note,
        t,
      ),
    ),
  );
  await setSetting(env, 'rules_seeded', '1');
}

export async function loadContains(env: Env): Promise<(ContainsRule & { id: string; merge: number })[]> {
  await ensureSeeded(env);
  const r = await env.DB.prepare('SELECT id, pattern, leaf_id, auto, merge FROM match_rules').all<ContainsRule & { id: string; merge: number }>();
  return r.results;
}

/**
 * Automatikus jóváhagyás: a jóváhagyásra váró banki tételek közül azokat, amelyekre automatikus
 * szabály illik, rögtön tényként könyveli a banki dátumra (a hónap költségei közé).
 */
export async function autoApprove(
  env: Env,
  approve: (env: Env, userId: number | null, items: { id: string; leaf_id: string; merge?: boolean }[]) => Promise<void>,
): Promise<number> {
  await archiveMergedDuplicates(env);
  const contains = (await loadContains(env)).filter((r) => r.auto);
  const learned = await env.DB.prepare('SELECT pattern, leaf_id, merge FROM partner_rules WHERE auto = 1').all<{
    pattern: string;
    leaf_id: string;
    merge: number;
  }>();
  if (!contains.length && !learned.results.length) return 0;
  const { sectionOf } = await sectionMap(env);
  const lmap: Record<string, string> = {};
  const lmerge: Record<string, number> = {};
  learned.results.forEach((r) => ((lmap[r.pattern] = r.leaf_id), (lmerge[r.pattern] = r.merge)));
  const txs = await env.DB.prepare("SELECT id, date, amount, partner, memo FROM bank_tx WHERE status = 'new'").all<{
    id: string;
    date: string;
    amount: number;
    partner: string;
    memo: string;
  }>();
  const items: { id: string; leaf_id: string; merge?: boolean }[] = [];
  const hits: Record<string, number> = {};
  for (const t of txs.results) {
    const c = matchContains(t, contains, sectionOf) as (ContainsRule & { id?: string }) | null;
    const leaf =
      c?.leaf_id ||
      (lmap[partnerKey(t.partner)] && sectionOf(lmap[partnerKey(t.partner)]) === (t.amount >= 0 ? 'in' : 'out') ? lmap[partnerKey(t.partner)] : null);
    if (!leaf) continue;
    items.push({ id: t.id, leaf_id: leaf, merge: c ? !!(c as any).merge : !!lmerge[partnerKey(t.partner)] });
    if (c?.id) hits[c.id] = (hits[c.id] || 0) + 1;
  }
  if (!items.length) return 0;
  await approve(env, null, items);
  for (const [id, n] of Object.entries(hits)) await env.DB.prepare('UPDATE match_rules SET hits = hits + ? WHERE id = ?').bind(n, id).run();
  return items.length;
}

export async function handleRules(
  env: Env,
  req: Request,
  path: string,
  u: User,
  reapply: () => Promise<{ updated: number; auto: number }>,
): Promise<Response | null> {
  if (!path.startsWith('/api/rules') && !path.startsWith('/api/partner-rules')) return null;

  if (path === '/api/rules' && req.method === 'GET') {
    await ensureSeeded(env);
    const [c, p] = await env.DB.batch([
      env.DB.prepare('SELECT id, pattern, leaf_id, auto, merge, note, source, hits FROM match_rules ORDER BY pattern'),
      env.DB.prepare('SELECT pattern, leaf_id, auto, merge, hits, updated_at FROM partner_rules ORDER BY hits DESC, pattern'),
    ]);
    return json({ contains: c.results, learned: p.results });
  }

  if (path === '/api/rules/suggestions' && req.method === 'GET') return json(await suggestions(env));

  requireRole(u, 'admin', 'member');

  if (path === '/api/rules' && req.method === 'POST') {
    const b = await readJson(req);
    const pattern = normalizeText(String(b.pattern || '')).slice(0, 80);
    if (pattern.length < 2) throw new HttpError(400, 'Adj meg legalább 2 karaktert (pl. a partner nevét).');
    const leaf = await env.DB.prepare('SELECT id FROM leaves WHERE id = ?')
      .bind(String(b.leaf_id || ''))
      .first();
    if (!leaf) throw new HttpError(400, 'Válassz kategóriát.');
    const id = randomId('r');
    await env.DB.prepare("INSERT INTO match_rules (id, pattern, leaf_id, auto, merge, note, source, updated_at) VALUES (?, ?, ?, ?, ?, ?, 'manual', ?)")
      .bind(id, pattern, b.leaf_id, b.auto ? 1 : 0, b.merge ? 1 : 0, b.note ? String(b.note).slice(0, 200) : null, now())
      .run();
    await audit(env, u.id, 'rule_created', { pattern, leaf: b.leaf_id, auto: !!b.auto });
    const r = await reapply();
    return json({ ok: true, id, ...r });
  }

  const m = path.match(/^\/api\/rules\/([\w-]+)$/);
  if (m && req.method === 'PATCH') {
    const b = await readJson(req);
    if (b.pattern !== undefined) {
      const p = normalizeText(String(b.pattern)).slice(0, 80);
      if (p.length < 2) throw new HttpError(400, 'Túl rövid minta.');
      await env.DB.prepare('UPDATE match_rules SET pattern = ?, updated_at = ? WHERE id = ?').bind(p, now(), m[1]).run();
    }
    if (b.leaf_id !== undefined)
      await env.DB.prepare('UPDATE match_rules SET leaf_id = ?, updated_at = ? WHERE id = ?').bind(String(b.leaf_id), now(), m[1]).run();
    if (b.auto !== undefined)
      await env.DB.prepare('UPDATE match_rules SET auto = ?, updated_at = ? WHERE id = ?')
        .bind(b.auto ? 1 : 0, now(), m[1])
        .run();
    if (b.note !== undefined)
      await env.DB.prepare('UPDATE match_rules SET note = ? WHERE id = ?')
        .bind(b.note ? String(b.note).slice(0, 200) : null, m[1])
        .run();
    await audit(env, u.id, 'rule_updated', { id: m[1], ...b });
    return json({ ok: true, ...(await reapply()) });
  }
  if (m && req.method === 'DELETE') {
    await env.DB.prepare('DELETE FROM match_rules WHERE id = ?').bind(m[1]).run();
    await audit(env, u.id, 'rule_deleted', { id: m[1] });
    return json({ ok: true });
  }

  if (path === '/api/partner-rules' && (req.method === 'PATCH' || req.method === 'DELETE')) {
    const b = await readJson(req);
    const pattern = String(b.pattern || '');
    if (req.method === 'DELETE') {
      await env.DB.prepare('DELETE FROM partner_rules WHERE pattern = ?').bind(pattern).run();
      return json({ ok: true });
    }
    if (b.leaf_id !== undefined)
      await env.DB.prepare('UPDATE partner_rules SET leaf_id = ?, updated_at = ? WHERE pattern = ?').bind(String(b.leaf_id), now(), pattern).run();
    if (b.auto !== undefined)
      await env.DB.prepare('UPDATE partner_rules SET auto = ?, updated_at = ? WHERE pattern = ?')
        .bind(b.auto ? 1 : 0, now(), pattern)
        .run();
    await audit(env, u.id, 'partner_rule_updated', { pattern, ...b });
    return json({ ok: true, ...(await reapply()) });
  }

  if (path === '/api/rules/apply' && req.method === 'POST') {
    return json({ ok: true, ...(await reapply()) });
  }
  return null;
}

export interface Suggestion {
  key: string; // normalizált partner kulcs
  partner: string; // minta a partner nevére
  leaf_id: string;
  count: number; // ennyiszer került ebbe a kategóriába
  total: number; // összes azonosított tétel
  months: number; // hány különböző hónapban
  avg: number; // átlagos összeg
  recurring: boolean;
}

/** Javaslatok: a banki archívum tételeit a tényekhez párosítva, partnerenként a jellemző kategória. */
async function suggestions(env: Env): Promise<Suggestion[]> {
  const contains = await loadContains(env);
  const { sectionOf } = await sectionMap(env);
  const [txR, actR, prR] = await env.DB.batch([
    env.DB.prepare("SELECT date, amount, partner, memo, actual_id FROM bank_tx WHERE partner <> '' ORDER BY date"),
    env.DB.prepare("SELECT id, date, amount, leaf_id FROM entries WHERE kind = 'actual'"),
    env.DB.prepare('SELECT pattern, leaf_id FROM partner_rules'),
  ]);
  const acts = actR.results as { id: string; date: string; amount: number; leaf_id: string }[];
  const byAmount = new Map<number, typeof acts>();
  acts.forEach((a) => byAmount.set(a.amount, [...(byAmount.get(a.amount) || []), a]));
  const byId = new Map(acts.map((a) => [a.id, a]));
  const learned = new Map((prR.results as { pattern: string; leaf_id: string }[]).map((r) => [r.pattern, r.leaf_id]));
  const used = new Set<string>();
  const agg = new Map<string, { partner: string; leaves: Map<string, number>; total: number; months: Set<string>; sum: number }>();
  for (const t of txR.results as { date: string; amount: number; partner: string; memo: string; actual_id: string | null }[]) {
    const key = partnerKey(t.partner);
    if (key.length < 3) continue;
    let leaf: string | null = t.actual_id ? (byId.get(t.actual_id)?.leaf_id ?? null) : null;
    if (!leaf) {
      const c = (byAmount.get(t.amount) || []).find((a) => !used.has(a.id) && Math.abs(Date.parse(a.date) - Date.parse(t.date)) <= 7 * 86400000);
      if (c) {
        used.add(c.id);
        leaf = c.leaf_id;
      }
    }
    if (!leaf) continue;
    const g = agg.get(key) || { partner: t.partner, leaves: new Map(), total: 0, months: new Set<string>(), sum: 0 };
    g.leaves.set(leaf, (g.leaves.get(leaf) || 0) + 1);
    g.total++;
    g.months.add(t.date.slice(0, 7));
    g.sum += t.amount;
    agg.set(key, g);
  }
  const out: Suggestion[] = [];
  for (const [key, g] of agg) {
    const [leaf_id, count] = [...g.leaves.entries()].sort((a, b) => b[1] - a[1])[0];
    if (g.total < 2 || count / g.total < 0.8) continue;
    // már lefedett: „tartalmazza” szabály vagy azonos tanult partner szabály
    const sample = { date: '', amount: g.sum, partner: g.partner, memo: '' };
    const c = matchContains(sample, contains, sectionOf);
    if (c && c.leaf_id === leaf_id) continue;
    if (learned.get(key) === leaf_id) continue;
    out.push({
      key,
      partner: g.partner,
      leaf_id,
      count,
      total: g.total,
      months: g.months.size,
      avg: Math.round(g.sum / g.total),
      recurring: g.months.size >= 3,
    });
  }
  return out.sort((a, b) => b.count - a.count).slice(0, 60);
}

/**
 * Összevonandó (havi) banki tételek egyeztetése a tényekkel: ha egy (bank + kategória + hónap) csoport
 * összege megegyezik egy már rögzített (pl. xls-ből importált) ténnyel a hónap körül, a banki tételek
 * archívumba kerülnek – így nem duplázódnak. (Az utólag számlázott díj a következő hónap elején jön.)
 */
export async function archiveMergedDuplicates(env: Env): Promise<number> {
  const contains = (await loadContains(env)).filter((r) => r.merge);
  if (!contains.length) return 0;
  const { sectionOf } = await sectionMap(env);
  // a csoport összegéhez az archivált (ignored) tételek is számítanak, csak a jóváhagyottak nem
  const txs = await env.DB.prepare(
    "SELECT id, account_id, date, amount, partner, memo, status FROM bank_tx WHERE status IN ('new', 'ignored') AND date >= date('now', '-150 days')",
  ).all<{
    id: string;
    account_id: string;
    date: string;
    amount: number;
    partner: string;
    memo: string;
    status: string;
  }>();
  const groups = new Map<string, { leaf: string; ym: string; sum: number; ids: string[] }>();
  for (const t of txs.results) {
    const c = matchContains(t, contains, sectionOf);
    if (!c) continue;
    const ym = t.date.slice(0, 7);
    const k = `${t.account_id}|${c.leaf_id}|${ym}`;
    const g = groups.get(k) || { leaf: c.leaf_id, ym, sum: 0, ids: [] };
    g.sum += t.amount;
    if (t.status === 'new') g.ids.push(t.id);
    groups.set(k, g);
  }
  let n = 0;
  for (const g of groups.values()) {
    if (!g.ids.length) continue;
    const [y, m] = g.ym.split('-').map(Number);
    const from = new Date(Date.UTC(y, m - 1, 1) - 5 * 86400000).toISOString().slice(0, 10);
    const to = new Date(Date.UTC(y, m, 0) + 10 * 86400000).toISOString().slice(0, 10);
    const f = await env.DB.prepare(
      "SELECT id FROM entries WHERE kind = 'actual' AND source = 'import' AND leaf_id = ? AND amount = ? AND date BETWEEN ? AND ? LIMIT 1",
    )
      .bind(g.leaf, g.sum, from, to)
      .first();
    if (!f) continue;
    for (const id of g.ids) await env.DB.prepare("UPDATE bank_tx SET status = 'ignored' WHERE id = ? AND status = 'new'").bind(id).run();
    n += g.ids.length;
  }
  return n;
}
