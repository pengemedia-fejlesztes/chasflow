// Banki tételek kategória-javaslata és tervvel való párosítása.
import { normalizeText } from './categories';
import type { Entry, Leaf } from './types';

const LEGAL = /\b(kft|zrt|nyrt|bt|kkt|ev|e v|ltd|limited|gmbh|inc|llc|sro|s r o|kozkereseti tarsasag|egyeni vallalkozo)\b/g;

/** Partner név normalizálása szabály-kulcsnak: "Alfa Kft." → "alfa" */
export function partnerKey(partner: string): string {
  return normalizeText(partner).replace(LEGAL, ' ').replace(/\s+/g, ' ').trim();
}

export interface RuleMap {
  [pattern: string]: string; // partnerKey → leaf_id
}

export interface TxLike {
  date: string;
  amount: number;
  partner: string;
  memo: string;
}

/** Kategória javaslat: 1) tanult szabály, 2) kategória név szerepel a partner/közlemény szövegben. */
export function suggestLeaf(tx: TxLike, rules: RuleMap, leaves: Leaf[], leafSection: (id: string) => 'in' | 'out'): string | null {
  const key = partnerKey(tx.partner);
  const wantSection = tx.amount >= 0 ? 'in' : 'out';
  if (key && rules[key] && leafSection(rules[key]) === wantSection) return rules[key];
  const hay = ' ' + normalizeText(tx.partner + ' ' + tx.memo) + ' ';
  let best: { id: string; len: number } | null = null;
  for (const l of leaves) {
    if (l.archived || leafSection(l.id) !== wantSection) continue;
    const n = normalizeText(l.label);
    if (n.length < 3 || n === 'egyeb') continue;
    if (hay.includes(' ' + n + ' ') || (n.length >= 5 && hay.includes(n))) {
      if (!best || n.length > best.len) best = { id: l.id, len: n.length };
    }
  }
  return best ? best.id : null;
}

function dayDiff(a: string, b: string): number {
  return Math.round((Date.parse(a) - Date.parse(b)) / 86400000);
}

/**
 * A banki tételhez legjobban illő nyitott terv.
 * Pontozás: azonos kategória, összeg-egyezés, dátum közelség, számlaszám a közleményben.
 */
export function matchPlan(tx: TxLike & { leaf_id?: string | null }, entries: Entry[], invoiceRefs: Record<string, string> = {}): Entry | null {
  const memoN = normalizeText(tx.memo + ' ' + tx.partner);
  let best: { e: Entry; score: number } | null = null;
  for (const e of entries) {
    if (e.kind !== 'plan' || e.done) continue;
    if (Math.sign(e.amount) !== Math.sign(tx.amount)) continue;
    const dd = dayDiff(tx.date, e.date);
    if (dd < -50 || dd > 75) continue;
    let score = 0;
    const inv = invoiceRefs[e.id];
    if (inv && memoN.includes(normalizeText(inv))) score += 100;
    if (tx.leaf_id && e.leaf_id === tx.leaf_id) score += 40;
    const a = Math.abs(tx.amount),
      b = Math.abs(e.amount);
    const rel = Math.abs(a - b) / Math.max(a, b, 1);
    if (rel === 0) score += 40;
    else if (rel < 0.02) score += 30;
    else if (rel < 0.15) score += 12;
    else if (rel > 0.5) score -= 30;
    score -= Math.min(20, Math.abs(dd) / 3);
    if (score < 30) continue;
    if (!best || score > best.score) best = { e, score };
  }
  return best ? best.e : null;
}
