// Havi terv–tény összesítő: tervezett és tényleges bevétel, kiadás, profit és az eltérések.
import type { Entry, Section } from './types';
import { budgetMonth, isBudgetPlan } from './budget';
import { ymOf } from './model';

export interface PvaMonth {
  ym: string;
  planIn: number;
  actIn: number;
  planOut: number; // pozitív szám (kiadás)
  actOut: number;
  /** nyitott (még nem teljesült) terv a hónapban */
  openIn: number;
  openOut: number;
  /** nyitott ajánlatok (tárgyalás alatt) */
  offerIn: number;
  offerOut: number;
  hasPlan: boolean;
  hasActual: boolean;
}

export const pvaProfit = (m: Pick<PvaMonth, 'planIn' | 'planOut' | 'actIn' | 'actOut'>) => ({ plan: m.planIn - m.planOut, act: m.actIn - m.actOut });

/**
 * Tervezett = a hónap összes (nem ajánlat) terve, teljesült és nyitott is; tény = a hónap tényei.
 * Keret-tervnél (pl. „Előre nem látható költség” 50 000/hó; ehhez kell a `leafLabel`) a hónap terve a keret – a besorolt
 * tételek abból fogynak, nem adódnak hozzá (mint az Áttekintésben); a nyitott rész a besorolt nyitott tételek + a keret maradéka.
 */
export function planVsActual(
  entries: Entry[],
  sectionOf: (leaf: string) => Section,
  months: string[],
  leafLabel?: (leaf: string) => string,
): PvaMonth[] {
  const map = new Map<string, PvaMonth>(
    months.map((ym) => [
      ym,
      { ym, planIn: 0, actIn: 0, planOut: 0, actOut: 0, openIn: 0, openOut: 0, offerIn: 0, offerOut: 0, hasPlan: false, hasActual: false },
    ]),
  );
  for (const e of entries) {
    const m = map.get(ymOf(e.date));
    if (!m || !e.amount) continue;
    const inc = sectionOf(e.leaf_id) === 'in';
    const v = inc ? e.amount : -e.amount;
    if (e.kind === 'actual') {
      m.hasActual = true;
      if (inc) m.actIn += v;
      else m.actOut += v;
    } else if (e.tentative) {
      if (!e.done) {
        if (inc) m.offerIn += v;
        else m.offerOut += v;
      }
    } else {
      m.hasPlan = true;
      if (inc) m.planIn += v;
      else m.planOut += v;
      if (!e.done) {
        if (inc) m.openIn += v;
        else m.openOut += v;
      }
    }
  }
  if (leafLabel) {
    // keret-terv: a kategória-hónap tervei helyett a keret szerinti terv és nyitott rész (kiadás, pozitív szám)
    const byLeaf = new Map<string, Entry[]>();
    for (const e of entries) if (sectionOf(e.leaf_id) === 'out') (byLeaf.get(e.leaf_id) || byLeaf.set(e.leaf_id, []).get(e.leaf_id)!).push(e);
    for (const [leaf, es] of byLeaf) {
      const label = leafLabel(leaf) || '';
      for (const ym of new Set(es.filter((e) => isBudgetPlan(e, label)).map((e) => ymOf(e.date)))) {
        const m = map.get(ym);
        const bm = m && budgetMonth(es, label, ym);
        if (!m || !bm) continue;
        const plans = es.filter((e) => e.kind === 'plan' && !e.tentative && ymOf(e.date) === ym);
        m.planOut += bm.plan + plans.reduce((a, e) => a + e.amount, 0);
        m.openOut += bm.openOther + bm.left + plans.filter((e) => !e.done).reduce((a, e) => a + e.amount, 0);
      }
    }
  }
  return months.map((ym) => map.get(ym)!);
}

/** A tervezés kezdő hónapja: a legkorábbi nem Billingo-ból jövő terv hónapja (a korábbi hónapokra nem volt teljes terv). */
export function planStart(entries: Entry[]): string | null {
  let min: string | null = null;
  for (const e of entries) if (e.kind === 'plan' && e.source !== 'billingo' && (!min || e.date < min)) min = e.date;
  return min ? ymOf(min) : null;
}

/** Pillanatkép (szerver) → PvaMonth */
export interface MonthStat {
  ym: string;
  plan_in: number;
  plan_out: number;
  offer_in: number;
  offer_out: number;
  act_in: number;
  act_out: number;
  closed: number;
  computed_at: number;
}

/**
 * Lezárt / folyó hónap a Terv vs. tény nézetben: a TERV a pillanatképből jön (befagyasztva, hogy az utólagos átütemezés
 * ne tüntesse el az eltérést), a TÉNY mindig élő – a hónap lezárása után beérkező / jóváhagyott banki tétel is látszik.
 */
export function closedMonth(s: MonthStat, live: Pick<PvaMonth, 'actIn' | 'actOut'>, offers = false) {
  return {
    planIn: s.plan_in + (offers ? s.offer_in : 0),
    planOut: s.plan_out + (offers ? s.offer_out : 0),
    actIn: live.actIn,
    actOut: live.actOut,
  };
}
