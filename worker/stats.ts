// Havi terv–tény pillanatképek: a lezárt hónap egyszer számolódik, a folyó hónap reggel és kézi frissítéskor.
import { addMonths, monthRange, ymOf } from '../shared/model';
import { planStart, planVsActual } from '../shared/planactual';
import type { Entry, Section } from '../shared/types';
import { Env, now, todayHu } from './util';

async function load(env: Env) {
  const [e, l, g] = await env.DB.batch([
    env.DB.prepare('SELECT id, kind, date, leaf_id, amount, done, tentative, source FROM entries'),
    env.DB.prepare('SELECT id, group_id FROM leaves'),
    env.DB.prepare('SELECT id, section FROM groups'),
  ]);
  const gs = new Map((g.results as { id: string; section: Section }[]).map((x) => [x.id, x.section]));
  const ls = new Map((l.results as { id: string; group_id: string }[]).map((x) => [x.id, gs.get(x.group_id) || 'out']));
  return { entries: e.results as unknown as Entry[], sectionOf: (id: string) => (ls.get(id) || 'out') as Section };
}

/**
 * Pillanatkép frissítése: a tervezés kezdetétől minden még nem lezárt múltbeli hónapot lezár (egyszer),
 * a folyó hónapot mindig újraszámolja. `recloseAll`: a lezárt hónapokat is újraszámolja (admin).
 */
export async function refreshMonthStats(env: Env, userId: number | null, recloseAll = false): Promise<{ closed: number; current: string }> {
  const today = todayHu();
  const cur = ymOf(today);
  const { entries, sectionOf } = await load(env);
  const start = planStart(entries) || cur;
  const existing = await env.DB.prepare('SELECT ym FROM month_stats WHERE closed = 1').all<{ ym: string }>();
  const closedSet = new Set(existing.results.map((r) => r.ym));
  const past = start < cur ? monthRange(start, addMonths(cur, -1)) : [];
  const todo = [...past.filter((ym) => recloseAll || !closedSet.has(ym)), cur];
  const rows = planVsActual(entries, sectionOf, todo);
  const t = now();
  const stmts = rows.map((r) =>
    env.DB.prepare(
      `INSERT INTO month_stats (ym, plan_in, plan_out, offer_in, offer_out, act_in, act_out, closed, computed_at, computed_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(ym) DO UPDATE SET plan_in = excluded.plan_in, plan_out = excluded.plan_out, offer_in = excluded.offer_in,
         offer_out = excluded.offer_out, act_in = excluded.act_in, act_out = excluded.act_out, closed = excluded.closed,
         computed_at = excluded.computed_at, computed_by = excluded.computed_by`,
    ).bind(
      r.ym,
      Math.round(r.planIn),
      Math.round(r.planOut),
      Math.round(r.offerIn),
      Math.round(r.offerOut),
      Math.round(r.actIn),
      Math.round(r.actOut),
      r.ym < cur ? 1 : 0,
      t,
      userId,
    ),
  );
  // a tervezés kezdete előtti (hiányos tervű) hónapok nem kapnak pillanatképet
  stmts.push(env.DB.prepare('DELETE FROM month_stats WHERE ym < ?').bind(start));
  await env.DB.batch(stmts);
  return { closed: rows.filter((r) => r.ym < cur).length, current: cur };
}
