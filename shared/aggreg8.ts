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
const clean = (s: string) =>
  unesc(s)
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
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
  return code === '162' ? 'MagNet' : code === '304' ? 'BiNX' : null;
}

/** Banki szinkron órái (Budapest) – a szerver ekkor szinkronizál, a Mac-bot ekkor tölti fel az aggreg8 adatait. */
export const SYNC_HOURS = [5, 9, 13, 17, 21];

// ---- aggreg8 backend JSON (standalone-backend.aggreg8.hu/transactions) – a Mac-bot ezt küldi feltöltéskor ----
// A mezőneveket tűrően keressük (a backend formátuma nem publikus); a tételenként hiányzó saját számlát az `account`
// mezőbe teheti a bot.

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v);
const lc = (k: string) => k.toLowerCase().replace(/[_\s-]/g, '');

/** Az első nem üres érték a megadott (kis/nagybetű- és aláhúzás-független) kulcsok közül, egy szint mélységig. */
function pick(o: Obj, keys: string[], depth = 1): unknown {
  const want = keys.map(lc);
  for (const w of want) for (const [k, v] of Object.entries(o)) if (lc(k) === w && v !== null && v !== undefined && v !== '') return v;
  if (depth > 0)
    for (const v of Object.values(o))
      if (isObj(v)) {
        const r = pick(v, keys, depth - 1);
        if (r !== undefined) return r;
      }
  return undefined;
}
const str = (v: unknown): string =>
  (isObj(v) ? String(pick(v, ['name', 'value', 'text', 'iban', 'accountNumber'], 0) ?? '') : String(v ?? '')).replace(/\s+/g, ' ').trim();
const num = (v: unknown): number => {
  if (isObj(v)) v = pick(v, ['amount', 'value'], 0);
  if (typeof v === 'number') return v;
  return (
    parseFloat(
      String(v ?? '')
        .replace(/\s/g, '')
        .replace(',', '.'),
    ) || 0
  );
};
const accNo = (v: unknown) => str(v).replace(/[\s-]/g, '').toUpperCase();

export interface A8JsonResult {
  accounts: A8Account[];
  balances: Record<string, number>;
  skipped: number;
}

export function parseAggreg8Json(body: unknown): A8JsonResult {
  const list: unknown[] = Array.isArray(body)
    ? body
    : isObj(body)
      ? ((['transactions', 'data', 'items', 'results'].map((k) => body[k]).find(Array.isArray) as unknown[]) ?? [])
      : [];
  if (!list.length && !(isObj(body) && Array.isArray(body.transactions))) throw new Error('Nincs tranzakció-lista (transactions).');
  if (list.length > A8_LIMITS.maxTx) throw new Error(`Túl sok tétel (legfeljebb ${A8_LIMITS.maxTx}).`);
  const byAcc = new Map<string, A8Account>();
  let skipped = 0;
  for (const t of list) {
    if (!isObj(t)) {
      skipped++;
      continue;
    }
    const date = str(pick(t, ['bookingDate', 'valueDate', 'date', 'transactionDate', 'createdAt'])).slice(0, 10);
    let amount = Math.round(num(pick(t, ['amount', 'transactionAmount', 'value'])));
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !amount) {
      skipped++;
      continue;
    }
    const dir = str(pick(t, ['direction', 'creditDebitIndicator'], 0)).toLowerCase();
    if (/^(expense|debit|dbit|outgoing)$/.test(dir) && amount > 0) amount = -amount;
    if (/^(income|credit|crdt|incoming)$/.test(dir) && amount < 0) amount = -amount;
    const own = pick(t, ['ownAccount'], 0);
    const account =
      accNo(pick(t, ['account', 'ownAccountNumber', 'ownIban'], 0)) ||
      (isObj(own) ? accNo(pick(own, ['iban', 'accountNumber', 'number'], 0)) : accNo(own)) ||
      accNo(pick(t, ['iban', 'accountNumber'], 0)) ||
      'ismeretlen';
    const cp = pick(t, ['counterparty', 'partner', 'counterpartyName', 'partnerName', 'creditorName', 'debtorName'], 0);
    const partner = (isObj(cp) ? str(pick(cp, ['name'], 0)) : str(cp)).slice(0, 200);
    const name = str(pick(t, ['transactionName', 'listTransactionName', 'description', 'title'], 0));
    const detail = str(pick(t, ['sourceDetailText', 'remittanceInformation', 'memo', 'narrative', 'comment'], 0));
    const memo = [name, detail && detail !== partner && detail !== name ? detail : ''].filter(Boolean).join(' · ').slice(0, 480);
    const id = str(pick(t, ['_id', 'id', 'localId', 'transactionId'], 0));
    if (!byAcc.has(account)) byAcc.set(account, { account, rows: [] });
    byAcc.get(account)!.rows.push({ date, amount, partner, memo, ...(id ? { ext: 'a8:' + id.slice(0, 120) } : {}) });
  }
  const balances: Record<string, number> = {};
  const b = isObj(body) ? body.balances : undefined;
  if (isObj(b)) for (const [k, v] of Object.entries(b)) if (Number.isFinite(num(v))) balances[accNo(k)] = Math.round(num(v));
  return { accounts: [...byAcc.values()], balances, skipped };
}
