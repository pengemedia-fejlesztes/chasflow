// Havi terv–tény összesítő: tervezett és tényleges bevétel, kiadás, profit és az eltérések.
import type { Entry, Section } from './types';
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
  hasPlan: boolean;
  hasActual: boolean;
}

export const pvaProfit = (m: Pick<PvaMonth, 'planIn' | 'planOut' | 'actIn' | 'actOut'>) => ({ plan: m.planIn - m.planOut, act: m.actIn - m.actOut });

/** Tervezett = a hónap összes (nem ajánlat) terve, teljesült és nyitott is; tény = a hónap tényei. */
export function planVsActual(entries: Entry[], sectionOf: (leaf: string) => Section, months: string[]): PvaMonth[] {
  const map = new Map<string, PvaMonth>(
    months.map((ym) => [ym, { ym, planIn: 0, actIn: 0, planOut: 0, actOut: 0, openIn: 0, openOut: 0, hasPlan: false, hasActual: false }]),
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
    } else if (!e.tentative) {
      m.hasPlan = true;
      if (inc) m.planIn += v;
      else m.planOut += v;
      if (!e.done) {
        if (inc) m.openIn += v;
        else m.openOut += v;
      }
    }
  }
  return months.map((ym) => map.get(ym)!);
}
