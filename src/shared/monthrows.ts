// Havi tétellista: terv + tény összevonása. Ha egy terv teljesült és van hozzá banki/importált tény,
// csak egy sor látszik (a tény összegével), az eltéréssel és a terv → teljesülés közti napok számával.
import type { BankTx, BillingoDoc, Entry } from './types';
import { normalizeText } from './categories';
import { ymOf } from './model';

export type RowKind = 'merged' | 'actual' | 'done' | 'plan' | 'offer';

export interface MonthRow {
  key: string;
  kind: RowKind;
  date: string;
  name: string;
  leaf_id: string;
  /** előjeles összeg: összevont sornál a tény */
  amount: number;
  plan?: Entry;
  actual?: Entry;
  /** tény − terv (előjeles) */
  diff: number;
  /** van-e lényeges eltérés (≥ 1 000 Ft és 1%) */
  dev: boolean;
  /** tény dátuma − terv dátuma (nap; + = később fizetve) */
  days: number | null;
  /** lejárt, nyitott terv */
  late: boolean;
  /** teljesült (tény / összevont / késznek jelölt) */
  completed: boolean;
}

const dayMs = 86400000;
export const daysBetween = (a: string, b: string) => Math.round((Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / dayMs);
export const isDeviation = (actual: number, plan: number) => Math.abs(actual - plan) >= Math.max(1000, Math.abs(plan) * 0.01);

/** Terv ↔ tény párok (terv.link_id = tény id, a terv teljesült). */
export function pairIndex(entries: Entry[]) {
  const byId = new Map(entries.map((e) => [e.id, e]));
  const planOfActual = new Map<string, Entry>();
  for (const p of entries) {
    if (p.kind !== 'plan' || !p.done || !p.link_id) continue;
    const a = byId.get(p.link_id);
    if (a && a.kind === 'actual') planOfActual.set(a.id, p);
  }
  return { byId, planOfActual };
}

function rowOf(kind: RowKind, today: string, plan?: Entry, actual?: Entry): MonthRow {
  const base = (actual || plan)!;
  const diff = plan && actual ? actual.amount - plan.amount : 0;
  return {
    key: (plan?.id || '') + ':' + (actual?.id || ''),
    kind,
    date: base.date,
    name: (plan?.name || actual?.name || '').trim(),
    leaf_id: base.leaf_id,
    amount: base.amount,
    plan,
    actual,
    diff,
    dev: !!(plan && actual && isDeviation(actual.amount, plan.amount)),
    days: plan && actual ? daysBetween(plan.date, actual.date) : null,
    late: kind === 'plan' && base.date < today,
    completed: kind === 'merged' || kind === 'actual' || kind === 'done',
  };
}

export function monthRows(entries: Entry[], ym: string, leafIds: Set<string>, today: string): MonthRow[] {
  const { byId, planOfActual } = pairIndex(entries);
  const out: MonthRow[] = [];
  for (const e of entries) {
    if (!leafIds.has(e.leaf_id) || ymOf(e.date) !== ym) continue;
    if (e.kind === 'actual') {
      const p = planOfActual.get(e.id);
      out.push(p ? rowOf('merged', today, p, e) : rowOf('actual', today, undefined, e));
    } else if (e.done) {
      // a teljesült terv a tény hónapjában jelenik meg (összevonva); tény nélkül itt, „kész” jelöléssel
      const a = e.link_id ? byId.get(e.link_id) : undefined;
      if (!a || a.kind !== 'actual') out.push(rowOf('done', today, e));
    } else out.push(rowOf(e.tentative ? 'offer' : 'plan', today, e));
  }
  return out.sort((a, b) => a.date.localeCompare(b.date) || a.name.localeCompare(b.name, 'hu'));
}

/** Átlagos fizetési eltérés (nap) egy kategóriában a teljesült terv–tény párokból. */
export function avgDelay(entries: Entry[], leafId: string): { avg: number; n: number } | null {
  const { byId } = pairIndex(entries);
  const ds: number[] = [];
  for (const p of entries) {
    if (p.kind !== 'plan' || !p.done || !p.link_id || p.leaf_id !== leafId) continue;
    const a = byId.get(p.link_id);
    if (a && a.kind === 'actual') ds.push(daysBetween(p.date, a.date));
  }
  return ds.length ? { avg: ds.reduce((s, x) => s + x, 0) / ds.length, n: ds.length } : null;
}

const norm = (s: string) => s.toLowerCase().replace(/\s+/g, '');

/** A tételhez tartozó Billingo számla (a terv forrása, a számla terv-hivatkozása vagy a banki közlemény számlaszáma). */
export function billingoDocFor(docs: BillingoDoc[], bankTx: BankTx[], plan?: Entry, actual?: Entry, leafLabel?: string): BillingoDoc | null {
  const refId = plan?.ext_ref?.startsWith('billingo:') ? Number(plan.ext_ref.slice(9)) : null;
  if (refId) {
    const d = docs.find((x) => x.id === refId);
    if (d) return d;
  }
  if (plan) {
    const d = docs.find((x) => x.plan_id === plan.id);
    if (d) return d;
  }
  if (actual) {
    const tx = actual.ext_ref?.startsWith('bank:') ? bankTx.find((t) => t.id === actual.ext_ref!.slice(5)) : undefined;
    const hay = norm(`${tx?.memo || ''} ${actual.note || ''} ${actual.name}`);
    const d = docs.find((x) => x.number && x.number.length >= 6 && hay.includes(norm(x.number)));
    if (d) return d;
    // „2026-000056” forma „Penge /” előtag nélkül
    const d2 = docs.find((x) => {
      const short = (x.number || '').match(/\d{4}[-/]\d{3,6}$/)?.[0];
      return short && hay.includes(norm(short));
    });
    if (d2) return d2;
    // importált tény (nincs közlemény): azonos összeg + partner (kategória neve) + közeli fizetési / számla dátum
    // partnerkulcs: a kategória neve vagy a tétel neve (pl. „Domain és tárhely” alatt „MOKLASZ”)
    const keyOf = (t?: string) => (t ? normalizeText(t).replace(/[^a-z0-9]/g, '') : '');
    const keys = [keyOf(leafLabel), keyOf(actual.name)].filter((k) => k.length >= 3);
    const cands = docs.filter((x) => {
      if (x.cancelled || Math.round(x.gross) !== Math.round(actual.amount)) return false;
      const pk = keyOf(x.partner || '');
      if (keys.length && !keys.some((k) => pk.includes(k))) return false;
      if (x.paid_date) return Math.abs(daysBetween(x.paid_date, actual.date)) <= 7;
      return !!x.invoice_date && daysBetween(x.invoice_date, actual.date) >= 0 && daysBetween(x.invoice_date, actual.date) <= 60;
    });
    if (cands.length)
      return cands.sort(
        (a, b) => Math.abs(daysBetween(a.paid_date || a.invoice_date!, actual.date)) - Math.abs(daysBetween(b.paid_date || b.invoice_date!, actual.date)),
      )[0];
  }
  return null;
}
