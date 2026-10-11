// aggreg8 „BankTransactionExport” XML feldolgozása DOM nélkül (a Workerben nincs DOMParser) – a Mac-ről automatikusan
// feltöltött napi exporthoz. Számlánként adja vissza a tételeket.
import type { BankFileRow } from './bankfile';

export interface A8Account {
  account: string;
  rows: BankFileRow[];
}

const unesc = (s: string) =>
  s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)))
    .replace(/&amp;/g, '&');
const clean = (s: string) => unesc(s).replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
const tag = (xml: string, name: string) => {
  const m = xml.match(new RegExp(`<(?:\\w+:)?${name}(?:\\s[^>]*)?>([\\s\\S]*?)</(?:\\w+:)?${name}>`));
  return m ? clean(m[1]) : '';
};

export const A8_LIMITS = { maxBytes: 10 * 1024 * 1024, maxTx: 30000 };

export function parseAggreg8(xml: string): A8Account[] {
  if (xml.length > A8_LIMITS.maxBytes) throw new Error('Túl nagy fájl (legfeljebb 10 MB).');
  if (!/<(?:\w+:)?BankTransactionExport[\s>]/.test(xml.slice(0, 4000))) throw new Error('Nem aggreg8 tranzakció-export (BankTransactionExport).');
  const byAcc = new Map<string, A8Account>();
  let n = 0;
  for (const m of xml.matchAll(/<(?:\w+:)?Transaction(?:\s[^>]*)?>([\s\S]*?)<\/(?:\w+:)?Transaction>/g)) {
    if (++n > A8_LIMITS.maxTx) throw new Error(`Túl sok tétel (legfeljebb ${A8_LIMITS.maxTx}).`);
    const t = m[1];
    const date = (tag(t, 'BookingDate') || tag(t, 'ValueDate')).slice(0, 10);
    let amount = Math.round(parseFloat(tag(t, 'Amount').replace(/\s/g, '').replace(',', '.')));
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !amount) continue;
    const dir = tag(t, 'Direction').toLowerCase();
    if (dir === 'expense' && amount > 0) amount = -amount;
    if (dir === 'income' && amount < 0) amount = -amount;
    const cp = tag(t, 'Counterparty');
    const partner = cp ? tag(`<x>${t.match(/<(?:\w+:)?Counterparty(?:\s[^>]*)?>([\s\S]*?)<\/(?:\w+:)?Counterparty>/)?.[1] || ''}</x>`, 'Name') : '';
    const own = t.match(/<(?:\w+:)?OwnAccount(?:\s[^>]*)?>([\s\S]*?)<\/(?:\w+:)?OwnAccount>/)?.[1] || '';
    const account = tag(own, 'AccountNumber').replace(/\s|-/g, '') || 'ismeretlen';
    const name = tag(t, 'TransactionName') || tag(t, 'ListTransactionName');
    const detail = tag(t, 'SourceDetailText');
    const memo = [name, detail && detail !== partner && detail !== name ? detail : ''].filter(Boolean).join(' · ').slice(0, 480);
    if (!byAcc.has(account)) byAcc.set(account, { account, rows: [] });
    byAcc.get(account)!.rows.push({ date, amount, partner, memo });
  }
  return [...byAcc.values()];
}

/** Bank a számlaszámból (magyar IBAN / belföldi számlaszám bankkódja). */
export function bankOfAccount(account: string): string | null {
  const code = /^HU\d{2}(\d{3})/.exec(account)?.[1] || /^(\d{3})/.exec(account)?.[1];
  return code === '162' ? 'MagNet' : null;
}
