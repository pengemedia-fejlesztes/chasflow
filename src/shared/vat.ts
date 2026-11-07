// ÁFA-terv: a havi bevétel (bruttó) ÁFA-tartalma (27/127), a következő hónapban fizetendő.
// Lezárt hónap: a bevételi tények; a folyó és a jövő hónapok: tény + nyitott, biztos (nem ajánlat) bevételi terv.
import { normalizeText } from './categories';
import { addMonths } from './model';
import type { Entry, Section } from './types';

export const VAT_RATE = 0.27;
/** az ÁFA alkategória (kiadás) felismerése a neve alapján */
export const isVatLeaf = (label: string) => normalizeText(label) === 'afa';

export interface VatMonth {
  /** a fizetés hónapja (YYYY-MM) */
  ym: string;
  /** a bevétel hónapja, amelynek az ÁFÁ-ja */
  base_ym: string;
  /** bruttó bevétel a bázishónapban */
  base: number;
  /** fizetendő ÁFA (pozitív) */
  vat: number;
}

/**
 * A folyó hónapot követő `count` hónap ÁFA-terve (a folyó hónapé nem: az a bevallás szerinti, kézzel rögzített érték marad).
 * @param cur a folyó hónap (YYYY-MM)
 */
export function vatPlan(
  entries: Pick<Entry, 'kind' | 'date' | 'leaf_id' | 'amount' | 'done' | 'tentative'>[],
  sectionOf: (leaf: string) => Section | undefined,
  cur: string,
  count = 12,
): VatMonth[] {
  const base = new Map<string, number>();
  for (const e of entries) {
    if (sectionOf(e.leaf_id) !== 'in' || !(e.amount > 0)) continue;
    const ym = e.date.slice(0, 7);
    const counts = e.kind === 'actual' || (ym >= cur && !e.done && !e.tentative);
    if (counts) base.set(ym, (base.get(ym) || 0) + e.amount);
  }
  return Array.from({ length: count }, (_, i) => {
    const ym = addMonths(cur, i + 1);
    const base_ym = addMonths(ym, -1);
    const b = base.get(base_ym) || 0;
    return { ym, base_ym, base: b, vat: Math.round((b * VAT_RATE) / (1 + VAT_RATE)) };
  });
}
