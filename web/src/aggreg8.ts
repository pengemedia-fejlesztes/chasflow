// aggreg8 „BankTransactionExport” XML (több saját számla egy fájlban) → számlánkénti tételek a kivonat-importhoz.
import type { BankFileRow } from '../../shared/bankfile';

export interface Aggreg8Account {
  account: string; // saját számlaszám (IBAN vagy belföldi)
  owner: string;
  rows: BankFileRow[];
  from: string;
  to: string;
  sum: number;
}

const MAX_BYTES = 10 * 1024 * 1024;
const MAX_TX = 30000;
const txt = (el: Element | null | undefined) => (el?.textContent || '').replace(/\s+/g, ' ').trim();
const child = (el: Element, name: string) => Array.from(el.children).find((c) => c.localName === name) || null;
const path = (el: Element, ...names: string[]) => names.reduce<Element | null>((e, n) => (e ? child(e, n) : null), el);

export const isAggreg8 = (text: string) => /<BankTransactionExport[\s>]/.test(text.slice(0, 2000));

export function parseAggreg8Xml(text: string): Aggreg8Account[] {
  if (text.length > MAX_BYTES) throw new Error('Túl nagy fájl (legfeljebb 10 MB).');
  const doc = new DOMParser().parseFromString(text, 'application/xml');
  if (doc.getElementsByTagName('parsererror').length) throw new Error('Hibás XML fájl.');
  const root = doc.documentElement;
  if (root.localName !== 'BankTransactionExport') throw new Error('Nem aggreg8 tranzakció-export (BankTransactionExport).');
  const txs = Array.from(root.getElementsByTagName('Transaction'));
  if (txs.length > MAX_TX) throw new Error(`Túl sok tétel (legfeljebb ${MAX_TX}).`);
  const byAcc = new Map<string, Aggreg8Account>();
  for (const t of txs) {
    const date = (txt(child(t, 'BookingDate')) || txt(child(t, 'ValueDate'))).slice(0, 10);
    let amount = Math.round(parseFloat(txt(child(t, 'Amount')).replace(/\s/g, '').replace(',', '.')));
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !amount) continue;
    const dir = txt(child(t, 'Direction')).toLowerCase();
    if (dir === 'expense' && amount > 0) amount = -amount;
    if (dir === 'income' && amount < 0) amount = -amount;
    const partner = txt(path(t, 'Counterparty', 'Name'));
    const name = txt(child(t, 'TransactionName')) || txt(child(t, 'ListTransactionName'));
    const detail = txt(child(t, 'SourceDetailText'));
    const memo = [name, detail && detail !== partner && detail !== name ? detail : ''].filter(Boolean).join(' · ').slice(0, 480);
    const account = txt(path(t, 'OwnAccount', 'AccountNumber')).replace(/\s|-/g, '') || 'ismeretlen';
    if (!byAcc.has(account)) byAcc.set(account, { account, owner: txt(path(t, 'OwnAccount', 'OwnerName')), rows: [], from: date, to: date, sum: 0 });
    const a = byAcc.get(account)!;
    a.rows.push({ date, amount, partner, memo });
    a.sum += amount;
    if (date < a.from) a.from = date;
    if (date > a.to) a.to = date;
  }
  return [...byAcc.values()];
}

/** A bank a számlaszámból: magyar IBAN (HU + 2 ellenőrző jegy + 3 jegyű bankkód) vagy belföldi számlaszám első 3 jegye. */
export function guessBank(account: string): string | null {
  const code = /^HU\d{2}(\d{3})/.exec(account)?.[1] || /^(\d{3})/.exec(account)?.[1];
  if (code === '162') return 'MagNet';
  if (code === '304') return 'BiNX';
  return null;
}

export const maskAccount = (a: string) => (a.length > 8 ? `${a.slice(0, 4)}…${a.slice(-4)}` : a);
