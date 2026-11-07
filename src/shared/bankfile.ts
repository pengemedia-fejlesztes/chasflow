// Netbank kivonat-exportok értelmezése (BiNX CSV, MagNet "tranzakcioKereses" XLS, általános CSV/XLSX).
import { parseAmount, parseDate } from './categories';

export interface BankFileRow {
  date: string;
  amount: number;
  partner: string;
  memo: string;
  ext?: string; // a bank saját tranzakció-azonosítója (duplikáció-szűréshez)
}

export interface BankFileResult {
  bank: string | null; // felismert bank
  rows: BankFileRow[];
  skipped: number; // nem teljesült / üres sorok
  from: string | null;
  to: string | null;
  sum: number;
}

const norm = (c: unknown) =>
  String(c ?? '')
    .toLowerCase()
    .trim();

/** A fájl soraiból (sheet_to_json header:1) kinyeri a tranzakciókat. */
export function parseBankRows(rows: unknown[][], fileName = ''): BankFileResult {
  const flat = rows.slice(0, 12).map((r) => r.map(norm).join(' | '));
  let bank: string | null = null;
  if (/binx/i.test(fileName) || flat.some((l) => l.includes('e-pénz rendelkezési számla'))) bank = 'BiNX';

  const hi = rows.findIndex((r) => {
    const h = r.map(norm);
    return h.some((c) => /d[aá]tum|date|könyvel|értéknap/.test(c)) && h.some((c) => /összeg|amount|terhel|jóváír/.test(c));
  });
  if (hi < 0) throw new Error('Nem találom a fejlécet (Dátum / Értéknap, Összeg …) a fájlban.');
  const head = rows[hi].map(norm);
  const col = (...res: RegExp[]) => {
    for (const re of res) {
      const i = head.findIndex((h) => re.test(h));
      if (i >= 0) return i;
    }
    return -1;
  };
  if (!bank && head.includes('ellenpartner') && head.includes('kód')) bank = 'MagNet';

  const cDate = col(/könyvelés napja|könyvelés dátuma/, /^értéknap$/, /könyvel/, /d[aá]tum|date/, /értéknap/);
  const cAmt = col(/^összeg$/, /összeg|amount/);
  const cDebit = col(/^terhelés$|terhelés összege/);
  const cCredit = col(/^jóváírás$|jóváírás összege/);
  const cTJ = col(/\(t\/j\)|terhelés vagy jóváírás/);
  const cPartner = col(/^ellenpartner$|partner neve/, /partner|kedvezményezett|ellenoldal|név|name|beneficiary|counterparty/);
  const cMemo = col(/közlemény/, /megjegyzés|memo|description|leírás|remittance/);
  const cId = col(/tranzakció azonosító|tranzakciós azonosító/, /^kód$/, /azonosító|reference|transaction id/);
  const cStatus = col(/^státusz$|^status$/);
  const cCur = col(/devizanem|currency/);

  const out: BankFileRow[] = [];
  let skipped = 0;
  const seen: Record<string, number> = {};
  for (const r of rows.slice(hi + 1)) {
    const date = parseDate(r[cDate]);
    if (!date) {
      skipped++;
      continue;
    }
    if (cStatus >= 0) {
      const st = norm(r[cStatus]);
      if (st && !/teljesült|könyvelt|booked|completed/.test(st)) {
        skipped++;
        continue;
      }
    }
    if (cCur >= 0 && norm(r[cCur]) && norm(r[cCur]) !== 'huf') {
      skipped++;
      continue;
    }
    let amount = cAmt >= 0 ? parseAmount(r[cAmt]) : 0;
    if (!amount && (cDebit >= 0 || cCredit >= 0)) {
      const cre = cCredit >= 0 ? Math.abs(parseAmount(r[cCredit])) : 0;
      const deb = cDebit >= 0 ? Math.abs(parseAmount(r[cDebit])) : 0;
      amount = cre ? cre : -deb;
    }
    if (cTJ >= 0) {
      const tj = norm(r[cTJ]);
      if (tj.startsWith('t')) amount = -Math.abs(amount);
      else if (tj.startsWith('j')) amount = Math.abs(amount);
    }
    if (!amount) {
      skipped++;
      continue;
    }
    const partner = cPartner >= 0 ? String(r[cPartner] ?? '').trim() : '';
    const memo = cMemo >= 0 ? String(r[cMemo] ?? '').trim() : '';
    let ext: string | undefined;
    if (cId >= 0 && String(r[cId] ?? '').trim()) {
      // a BiNX ugyanazt az azonosítót adja az utalásnak és a hozzá tartozó díjnak → összeggel együtt egyedi
      const base = `${String(r[cId]).trim().replace(/\.0$/, '')}|${amount}`;
      seen[base] = (seen[base] || 0) + 1;
      ext = seen[base] > 1 ? `${base}|${seen[base]}` : base;
    }
    out.push({ date, amount, partner, memo, ext });
  }
  const dates = out.map((r) => r.date).sort();
  return { bank, rows: out, skipped, from: dates[0] || null, to: dates[dates.length - 1] || null, sum: out.reduce((s, r) => s + r.amount, 0) };
}
