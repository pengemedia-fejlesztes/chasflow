// Banki jóváírás ↔ nyitott Billingo-számla párosítása a számla fizetettre állításához.
// Csak akkor párosít, ha az összeg forintra pontosan egyezik ÉS a számla beazonosítható: a számlaszám szerepel a
// közleményben, vagy a partner (név / partnertörzs alternatív neve / a tétel partnere) egyezik. Kétes esetben nem párosít.
import { normalizeText } from './categories';
import { partnerKey } from './match';

export interface PayTx {
  id: string;
  date: string;
  amount: number;
  currency: string;
  partner: string;
  memo: string;
  /** a banki tétel partnere (a kategória partnerkulcsa), ha ismert */
  partnerId?: string | null;
}
export interface PayDoc {
  id: number;
  number: string | null;
  partner: string | null;
  gross: number;
  currency: string | null;
  invoice_date: string | null;
  /** a számlához tartozó terv partnere (partnerkulcs), ha ismert */
  partnerId?: string | null;
}
export interface PayMatch {
  tx: PayTx;
  doc: PayDoc;
  why: 'számlaszám' | 'partner';
}

const compact = (s: string) => normalizeText(s).replace(/[^a-z0-9]/g, '');
const dayMs = (d: string) => Date.parse(d + 'T00:00:00Z');

/** Partnernevek egyezése: azonos kulcs, vagy az egyik (legalább 4 karakteres) a másikban szóhatáron. */
export function namesMatch(a: string, b: string): boolean {
  const x = partnerKey(a),
    y = partnerKey(b);
  if (x.length < 3 || y.length < 3) return false;
  if (x === y) return true;
  const inside = (s: string, t: string) => s.length >= 4 && (' ' + t + ' ').includes(' ' + s + ' ');
  return inside(x, y) || inside(y, x);
}

/**
 * @param aliasesOf egy számlapartner névhez a partnertörzs szerinti összes név (név + alternatív nevek)
 */
export function matchPayments(txs: PayTx[], docs: PayDoc[], aliasesOf: (name: string) => string[] = (n) => [n]): PayMatch[] {
  const out: PayMatch[] = [];
  const usedDocs = new Set<number>();
  for (const tx of [...txs].sort((a, b) => a.date.localeCompare(b.date))) {
    if (tx.amount <= 0 || (tx.currency || 'HUF') !== 'HUF') continue;
    const text = `${tx.partner} ${tx.memo}`;
    const textC = compact(text);
    const cands: PayMatch[] = [];
    for (const d of docs) {
      if (usedDocs.has(d.id) || (d.currency || 'HUF') !== 'HUF' || Math.round(d.gross) !== Math.round(tx.amount)) continue;
      // a fizetés nem lehet jóval a számla kelte előtt
      if (d.invoice_date && dayMs(tx.date) < dayMs(d.invoice_date) - 3 * 86400_000) continue;
      const num = compact(d.number || '');
      if (num.length >= 5 && textC.includes(num)) {
        cands.push({ tx, doc: d, why: 'számlaszám' });
        continue;
      }
      const names = d.partner ? aliasesOf(d.partner) : [];
      const byName = names.some(
        (n) => namesMatch(n, tx.partner) || (partnerKey(n).length >= 5 && (' ' + partnerKey(tx.memo) + ' ').includes(' ' + partnerKey(n) + ' ')),
      );
      const byLeaf = !!tx.partnerId && !!d.partnerId && tx.partnerId === d.partnerId;
      if (byName || byLeaf) cands.push({ tx, doc: d, why: 'partner' });
    }
    const byNum = cands.filter((c) => c.why === 'számlaszám');
    // egyértelműség: számlaszám alapján pontosan egy, vagy (számlaszám nélkül) pontosan egy partner szerinti jelölt
    const pick = byNum.length === 1 ? byNum[0] : byNum.length === 0 && cands.length === 1 ? cands[0] : null;
    if (pick) {
      usedDocs.add(pick.doc.id);
      out.push(pick);
    }
  }
  return out;
}
