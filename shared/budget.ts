// Keret-terv: a kiadási alkategória saját nevű terve (pl. „Előre nem látható költség” 50 000 Ft/hó) egy havi keret.
// A kategóriába sorolt többi tétel (pl. egy X-Page számla 4 051 Ft) ebből fogy, nem adódik hozzá: a hónap terve a keret
// (ha a tételek együtt többek, akkor azok), a felhasznált rész a tételek összege, a maradék a megtakarítás.
import { normalizeText } from './categories';
import { ymOf } from './model';
import { baseName } from './monthname';
import type { Entry } from './types';

/** keret-terv: biztos terv, amelynek a neve (hónap nélkül) maga az alkategória neve */
export const isBudgetPlan = (e: Entry, leafLabel: string) =>
  e.kind === 'plan' && !e.tentative && !!leafLabel && normalizeText(baseName(e.name || '')) === normalizeText(leafLabel);

export interface BudgetMonth {
  /** a keret (abszolút érték) */
  budget: number;
  /** felhasználva: a többi tétel (teljesült tervnél a tény, nyitottnál a terv) + a terv nélküli tények */
  used: number;
  /** a hónap terve: a keret, vagy ha a tételek többek, azok összege */
  plan: number;
  /** még nyitott tervek (a kereten kívüli tételekből) */
  openOther: number;
  /** a keretből még hátralévő rész (≥ 0) */
  left: number;
  /** a keret-terv már le van zárva */
  closed: boolean;
}

/**
 * Egy alkategória egy hónapja kerettel. `es`: az alkategória tételei (tervek és tények); null, ha nincs keret-terv.
 * Minden összeg abszolút értékben (kiadás).
 */
export function budgetMonth(es: Entry[], leafLabel: string, ym: string): BudgetMonth | null {
  const inM = es.filter((e) => ymOf(e.date) === ym);
  const budgets = inM.filter((e) => isBudgetPlan(e, leafLabel));
  if (!budgets.length) return null;
  const byId = new Map(es.map((e) => [e.id, e]));
  const others = inM.filter((e) => e.kind === 'plan' && !e.tentative && !isBudgetPlan(e, leafLabel));
  const otherLinked = new Set(others.map((e) => e.link_id).filter(Boolean) as string[]);
  const budget = Math.abs(budgets.reduce((a, e) => a + e.amount, 0));
  let used = 0,
    openOther = 0,
    otherPlan = 0;
  for (const o of others) {
    otherPlan += Math.abs(o.amount);
    const act = o.done && o.link_id ? byId.get(o.link_id) : undefined;
    used += Math.abs(act ? act.amount : o.amount);
    if (!o.done) openOther += Math.abs(o.amount);
  }
  // terv nélküli (vagy a keret-tervhez kötött) tények is a keretből fogynak
  for (const a of inM) if (a.kind === 'actual' && !otherLinked.has(a.id)) used += Math.abs(a.amount);
  const closed = budgets.every((b) => b.done);
  return { budget, used, plan: Math.max(budget, otherPlan), openOther, left: closed ? 0 : Math.max(0, budget - used), closed };
}
