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
      env.DB.prepare("INSERT INTO match_rules (id, pattern, leaf_id, auto, note, source, updated_at) VALUES (?, ?, ?, ?, ?, 'builtin', ?)").bind(
        randomId('r'),
        r.pattern,
        r.leaf_id,
        r.auto,
        r.note,
        t,
      ),
    ),
  );
  await setSetting(env, 'rules_seeded', '1');
}

export async function loadContains(env: Env): Promise<(ContainsRule & { id: string })[]> {
  await ensureSeeded(env);
  const r = await env.DB.prepare('SELECT id, pattern, leaf_id, auto FROM match_rules').all<ContainsRule & { id: string }>();
  return r.results;
}

/**
 * Automatikus jóváhagyás: a jóváhagyásra váró banki tételek közül azokat, amelyekre automatikus
 * szabály illik, rögtön tényként könyveli a banki dátumra (a hónap költségei közé).
 */
export async function autoApprove(
  env: Env,
  approve: (env: Env, userId: number | null, items: { id: string; leaf_id: string }[]) => Promise<void>,
): Promise<number> {
  const contains = (await loadContains(env)).filter((r) => r.auto);
  const learned = await env.DB.prepare('SELECT pattern, leaf_id FROM partner_rules WHERE auto = 1').all<{ pattern: string; leaf_id: string }>();
  if (!contains.length && !learned.results.length) return 0;
  const { sectionOf } = await sectionMap(env);
  const lmap: Record<string, string> = {};
  learned.results.forEach((r) => (lmap[r.pattern] = r.leaf_id));
  const txs = await env.DB.prepare("SELECT id, date, amount, partner, memo FROM bank_tx WHERE status = 'new'").all<{
    id: string;
    date: string;
    amount: number;
    partner: string;
    memo: string;
  }>();
  const items: { id: string; leaf_id: string }[] = [];
  const hits: Record<string, number> = {};
  for (const t of txs.results) {
    const c = matchContains(t, contains, sectionOf) as (ContainsRule & { id?: string }) | null;
    const leaf =
      c?.leaf_id ||
      (lmap[partnerKey(t.partner)] && sectionOf(lmap[partnerKey(t.partner)]) === (t.amount >= 0 ? 'in' : 'out') ? lmap[partnerKey(t.partner)] : null);
    if (!leaf) continue;
    items.push({ id: t.id, leaf_id: leaf });
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
      env.DB.prepare('SELECT id, pattern, leaf_id, auto, note, source, hits FROM match_rules ORDER BY pattern'),
      env.DB.prepare('SELECT pattern, leaf_id, auto, hits, updated_at FROM partner_rules ORDER BY hits DESC, pattern'),
    ]);
    return json({ contains: c.results, learned: p.results });
  }

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
    await env.DB.prepare("INSERT INTO match_rules (id, pattern, leaf_id, auto, note, source, updated_at) VALUES (?, ?, ?, ?, ?, 'manual', ?)")
      .bind(id, pattern, b.leaf_id, b.auto ? 1 : 0, b.note ? String(b.note).slice(0, 200) : null, now())
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
