// ÁFA-terv karbantartása szinkronkor: a következő 12 hónap ÁFA-terve az előző havi bevételből (27/127), a következő hónapban.
// A számított tervek azonosítója „vat_YYYY-MM” (forrás: vat). A folyó hónap terve kézi (bevallás szerinti) marad;
// a jövő hónapok kézi (nem számított) nyitott ÁFA-tervei a kukába kerülnek (visszaállíthatók), hogy ne duplázódjanak.
import { addMonths } from '../shared/model';
import type { Section } from '../shared/types';
import { isVatLeaf, vatPlan } from '../shared/vat';
import { effectiveRule, payDate } from '../shared/workdays';
import { Env, now, todayHu } from './util';

export async function refreshVatPlans(env: Env): Promise<{ months: number; changed: number; removed: number } | null> {
  const [leavesR, groupsR] = await env.DB.batch([
    env.DB.prepare('SELECT id, group_id, label, archived, pay_rule FROM leaves'),
    env.DB.prepare('SELECT id, section, pay_rule FROM groups'),
  ]);
  const groups = new Map((groupsR.results as { id: string; section: Section; pay_rule: string | null }[]).map((g) => [g.id, g]));
  const leaves = leavesR.results as { id: string; group_id: string; label: string; archived: number; pay_rule: string | null }[];
  const sectionOf = (id: string) => groups.get(leaves.find((l) => l.id === id)?.group_id || '')?.section;
  const vatLeaf = leaves.find((l) => !l.archived && isVatLeaf(l.label) && groups.get(l.group_id)?.section === 'out');
  if (!vatLeaf) return null;

  const cur = todayHu().slice(0, 7);
  const from = addMonths(cur, -1) + '-01';
  const rows = await env.DB.prepare('SELECT kind, date, leaf_id, amount, done, tentative FROM entries WHERE date >= ?')
    .bind(from)
    .all<{ kind: 'plan' | 'actual'; date: string; leaf_id: string; amount: number; done: number; tentative: number }>();
  const plan = vatPlan(rows.results, sectionOf, cur);
  const rule = effectiveRule(vatLeaf, groups.get(vatLeaf.group_id));
  const t = now();
  const next = addMonths(cur, 1) + '-01';
  const stmts: D1PreparedStatement[] = [
    // a jövő hónapok kézi ÁFA-tervei → kuka (a számított terv lép a helyükre)
    env.DB.prepare(
      `INSERT INTO deleted_entries (id, kind, date, leaf_id, name, amount, series_id, done, tentative, source, ext_ref, link_id, note, updated_at, updated_by, deleted_at, deleted_by)
       SELECT id, kind, date, leaf_id, name, amount, series_id, done, tentative, source, ext_ref, link_id, note, updated_at, updated_by, ?, NULL
       FROM entries WHERE kind = 'plan' AND done = 0 AND leaf_id = ? AND date >= ? AND COALESCE(source, '') != 'vat'`,
    ).bind(t, vatLeaf.id, next),
    env.DB.prepare("DELETE FROM entries WHERE kind = 'plan' AND done = 0 AND leaf_id = ? AND date >= ? AND COALESCE(source, '') != 'vat'").bind(vatLeaf.id, next),
  ];
  for (const m of plan) {
    const id = `vat_${m.ym}`;
    const date = payDate(m.ym, rule, 20);
    if (!m.vat) {
      stmts.push(env.DB.prepare("DELETE FROM entries WHERE id = ? AND done = 0 AND source = 'vat'").bind(id));
      continue;
    }
    stmts.push(
      env.DB.prepare(
        `INSERT INTO entries (id, kind, date, leaf_id, name, amount, done, tentative, source, note, updated_at)
         VALUES (?, 'plan', ?, ?, 'ÁFA (számított)', ?, 0, 0, 'vat', ?, ?)
         ON CONFLICT(id) DO UPDATE SET amount = excluded.amount, date = excluded.date, leaf_id = excluded.leaf_id, note = excluded.note,
           updated_at = excluded.updated_at
         WHERE entries.done = 0 AND (entries.amount != excluded.amount OR entries.date != excluded.date OR entries.leaf_id != excluded.leaf_id)`,
      ).bind(id, date, vatLeaf.id, -m.vat, `${m.base_ym.replace('-', '.')}. havi bevétel ${m.base.toLocaleString('hu-HU')} Ft × 27/127`, t),
    );
  }
  const res = await env.DB.batch(stmts);
  const removed = res[1].meta.changes || 0;
  const changed = res.slice(2).reduce((s, r) => s + (r.meta.changes || 0), 0);
  return { months: plan.length, changed, removed };
}
