// Terv nélküli tétel (banki tény vagy NAV-számla) besorolási javaslata:
//  - rendszeres: az elmúlt 12 hónapból legalább 3 hónapban volt ugyanettől a partnertől / ugyanilyen tétel → vedd fel havonta a tervbe
//  - előre nem látható: először (vagy csak elvétve) fordul elő → „Előre nem látható költség”
import { normalizeText } from './categories';
import { partnerKey } from './match';
import type { Entry } from './types';

export const RECURRING_MIN_MONTHS = 3;

export interface UnplannedHint {
  kind: 'recurring' | 'oneoff';
  /** hány különböző hónapban fordult elő az elmúlt 12 hónapban (ezt nem számítva) */
  months: number;
  /** átlagos havi összeg (előjeles) */
  avg: number;
  /** a leggyakoribb kategória az előzményekben */
  leaf_id: string | null;
}

const ymOf = (d: string) => d.slice(0, 7);
const minusYear = (d: string) => String(Number(d.slice(0, 4)) - 1) + d.slice(4);

/** Az első érdemi szó (pl. „Rackforest Zrt.” → „rackforest”) – a banki és a számlanév ritkán egyezik betűre. */
const head = (s: string) =>
  partnerKey(s)
    .split(' ')
    .filter((w) => w.length >= 3)
    .slice(0, 2)
    .join(' ');

export function unplannedHint(
  entries: Entry[],
  it: { name: string; amount: number; date: string; leaf_id?: string | null; id?: string },
  unforeseen?: string | null,
): UnplannedHint {
  const key = head(it.name);
  const from = minusYear(it.date);
  const sameSign = Math.sign(it.amount);
  const hits = entries.filter((e) => {
    if (e.kind !== 'actual' || e.id === it.id || e.date < from || e.date > it.date || Math.sign(e.amount) !== sameSign) return false;
    if (ymOf(e.date) === ymOf(it.date)) return false;
    const nameHit = key.length >= 3 && normalizeText(e.name).includes(key);
    // azonos (nem „előre nem látható”) kategória, hasonló összeg
    const leafHit =
      !!it.leaf_id && it.leaf_id !== unforeseen && e.leaf_id === it.leaf_id && Math.abs(Math.abs(e.amount) - Math.abs(it.amount)) <= Math.abs(it.amount) * 0.25;
    return nameHit || leafHit;
  });
  const months = new Set(hits.map((e) => ymOf(e.date))).size;
  // az átlag elsősorban az azonos partner tételeiből (a kategória más tételei torzítanák)
  const byName = hits.filter((e) => key.length >= 3 && normalizeText(e.name).includes(key));
  const base = byName.length ? byName : hits;
  const byMonth: Record<string, number> = {};
  base.forEach((e) => (byMonth[ymOf(e.date)] = (byMonth[ymOf(e.date)] || 0) + e.amount));
  const nm = Object.keys(byMonth).length;
  const avg = nm ? Math.round(Object.values(byMonth).reduce((a, b) => a + b, 0) / nm) : it.amount;
  const cnt: Record<string, number> = {};
  hits.forEach((e) => e.leaf_id !== unforeseen && (cnt[e.leaf_id] = (cnt[e.leaf_id] || 0) + 1));
  const leaf = Object.keys(cnt).sort((a, b) => cnt[b] - cnt[a])[0] || (it.leaf_id && it.leaf_id !== unforeseen ? it.leaf_id : null);
  return { kind: months >= RECURRING_MIN_MONTHS ? 'recurring' : 'oneoff', months, avg, leaf_id: leaf };
}
