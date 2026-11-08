// aggreg8 tranzakciók és egyenlegek összegyűjtése az aggreg8 standalone API-jából – ugyanaz a logika, mint a Mac-es
// böngészős exportnál (web/public/mac/aggreg8-export.js), de a szerver futtatja. A kimenet a /api/ingest/aggreg8 JSON-formátuma.

export type A8Get = (path: string, soft?: boolean) => Promise<any>;

const arr = (j: any): any[] => (Array.isArray(j) ? j : (j && (j.data || j.items || j.results || j.transactions || j.consents)) || []);
const dayOf = (t: any) => String((t && (t.bookingDate || t.valueDate || t.date)) || '').slice(0, 10);
const IB = /^HU\d{2}[0-9 ]{20,34}$/;

function ibansIn(o: unknown, d = 0, out: string[] = []): string[] {
  if (typeof o === 'string') {
    if (IB.test(o.trim())) out.push(o.replace(/\s/g, ''));
  } else if (o && typeof o === 'object' && d < 6) Object.values(o).forEach((v) => ibansIn(v, d + 1, out));
  return out;
}

export interface A8Export {
  balances: Record<string, number>;
  transactions: any[];
  /** a beolvasott oldalak (diagnosztika) */
  pages: string[];
}

/** a tranzakciók lapozva (a legújabbal kezdődnek), a since-nél régebbi oldalnál megáll; a bankkapcsolatokból számla és egyenleg */
export async function collectAggreg8(get: A8Get, since: string, sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))): Promise<A8Export> {
  const tx: any[] = [];
  const seen = new Set<string>();
  const pages: string[] = [];
  let tp = 0;
  for (let p = 0; p <= 80; p++) {
    let j = await get('/transactions?page=' + p, true);
    if (!j && p > 0 && (!tp || p <= tp)) {
      await sleep(2000);
      j = await get('/transactions?page=' + p, true);
    }
    if (!j) {
      if (p === 0) continue;
      break;
    }
    const items = arr(j);
    let fresh = 0;
    for (const t of items) {
      const id = t && (t._id || t.id);
      if (id && seen.has(String(id))) continue;
      if (id) seen.add(String(id));
      tx.push(t);
      fresh++;
    }
    pages.push(p + ':' + fresh);
    const days = items.map(dayOf).filter(Boolean);
    if (since && days.length && days.some((d: string) => d < since)) break;
    const m = (j && j.meta) || {};
    tp = m.totalPages || m.total_pages || m.lastPage || m.pageCount || tp;
    if (!items.length || (!fresh && p > 1)) break;
    if (tp && p >= tp) break;
  }
  let cons: any[] = [];
  try {
    cons = arr(await get('/bank-access-consents'));
  } catch {
    cons = [];
  }
  // azonosító → saját IBAN (a bankkapcsolatokból), csak ahol egyértelmű
  const map: Record<string, string> = {};
  const mapIds = (o: any, d = 0) => {
    if (!o || typeof o !== 'object' || d > 5) return;
    const ib = [...new Set(ibansIn(o))];
    if (ib.length === 1)
      ['_id', 'id', 'accountId', 'consentId', 'resourceId'].forEach((k) => {
        if (typeof o[k] === 'string' || typeof o[k] === 'number') map[String(o[k])] = ib[0];
      });
    Object.values(o).forEach((v) => mapIds(v, d + 1));
  };
  cons.forEach((c) => mapIds(c));
  const findAcc = (o: any, d = 0): string | null => {
    if ((typeof o === 'string' || typeof o === 'number') && map[String(o)]) return map[String(o)];
    if (o && typeof o === 'object' && d < 4)
      for (const v of Object.values(o)) {
        const a = findAcc(v, d + 1);
        if (a) return a;
      }
    return null;
  };
  const keep = since && tx.some((t) => dayOf(t)) ? tx.filter((t) => !dayOf(t) || dayOf(t) >= since) : tx;
  const balances: Record<string, number> = {};
  cons.forEach((c) =>
    ((c && c.consentedAccounts) || []).forEach((a: any) => {
      const b = a && a.balances && (a.balances.bookedBalance || a.balances.availableBalance);
      if (a && a.accountNumber && b && Number.isFinite(Number(b.amount))) balances[String(a.accountNumber).replace(/\s/g, '')] = Number(b.amount);
    }),
  );
  return {
    balances,
    pages,
    transactions: keep.map((t) => {
      if (!t || typeof t !== 'object' || t.account) return t;
      const a = findAcc(Object.fromEntries(Object.entries(t).filter(([k]) => k !== '_id' && k !== 'id')));
      return a ? { ...t, account: a } : t;
    }),
  };
}

/** a bankkapcsolatok azonosítói (ezekre indítható banki frissítés) */
export async function consentIds(get: A8Get): Promise<{ id: string; bank: string; validUntil: string | null }[]> {
  const cons = arr(await get('/bank-access-consents'));
  return cons
    .filter((c) => c && (c._id || c.id))
    .map((c) => ({
      id: String(c._id || c.id),
      bank: String((c.bank && (c.bank.name || c.bank.shortName)) || c.bankName || c.bankId || ''),
      validUntil: c.validUntil || c.expiresAt || c.consentValidUntil || null,
    }));
}

/** a JWT lejárata (ms), ha kiolvasható */
export function jwtExpMs(token: string): number | null {
  try {
    const p = token.split('.')[1];
    const json = JSON.parse(atob(p.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((p.length + 3) % 4)));
    return typeof json.exp === 'number' ? json.exp * 1000 : null;
  } catch {
    return null;
  }
}
