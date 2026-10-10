// Riasztások („red flag”): ahol a tény eltér a havi tervtől.
//  - eltérés: a tény tervhez kötve, de más összeggel (pl. Aranka 40 000 helyett 44 000)
//  - nem tervezett: tény, amihez nem tartozott terv (pl. előre nem látható költség)
//  - új számla (NAV): bejövő szállítói számla, amihez nincs terv – még a kifizetés előtt
//  - elmaradt: lejárt, még nyitott terv (nem jött be a bevétel / nem ment ki a kiadás)
// Csak a jelen számít: az előző hónap elejétől, de legkorábban az utolsó importált (XLS) tény utáni naptól.
import type { BankTx, Entry, NavInvoice, Section } from './types';
import { addMonths, ymOf } from './model';

export type FlagKind = 'target' | 'invoice' | 'uninvoiced' | 'underbilled' | 'deviation' | 'unplanned' | 'overdue';

export interface Flag {
  id: string;
  kind: FlagKind;
  section: Section;
  date: string;
  name: string;
  leaf_id: string;
  /** a tény összege (elmaradtnál a terv összege) */
  amount: number;
  plan?: number;
  /** tény − terv, előjelesen (kiadásnál a negatív = többet fizettünk) */
  diff?: number;
  entry_id: string;
  /** banki tétel, amiből a tény jött */
  tx?: BankTx;
  /** NAV-számla (terv nélküli bejövő számla) */
  nav?: NavInvoice;
}

/** Eltérés küszöb: legalább 1 000 Ft és a terv 1%-a. */
export const DEV_MIN_FT = 1000;
export const DEV_MIN_REL = 0.01;
/** Banki könyvelési türelmi idő az elmaradt tervekhez (nap). */
export const OVERDUE_GRACE_DAYS = 1;

const addDays = (d: string, n: number) => {
  const t = new Date(d + 'T00:00:00Z');
  t.setUTCDate(t.getUTCDate() + n);
  return t.toISOString().slice(0, 10);
};

/** A figyelt időszak kezdete. */
export function flagsFrom(entries: Entry[], today: string): string {
  const lastImport = entries.reduce((m, e) => (e.kind === 'actual' && e.source === 'import' && e.date <= today && e.date > m ? e.date : m), '');
  const prevMonth = addMonths(ymOf(today), -1) + '-01';
  const afterImport = lastImport ? addDays(lastImport, 1) : '';
  return afterImport > prevMonth ? afterImport : prevMonth;
}

export function computeFlags(entries: Entry[], bankTx: BankTx[], sectionOf: (leaf: string) => Section, today: string, ack: string[] = []): Flag[] {
  const from = flagsFrom(entries, today);
  const acked = new Set(ack);
  const byId = new Map(entries.map((e) => [e.id, e]));
  const txByActual = new Map(bankTx.filter((t) => t.actual_id).map((t) => [t.actual_id as string, t]));
  const out: Flag[] = [];
  const curYm = ymOf(today);

  for (const e of entries) {
    if (e.date > today) continue;
    // a Billingo-számla akkor is elmaradt, ha régebben járt le (a fizetési státuszt a Billingo adja)
    if (e.date < from && !(e.kind === 'plan' && e.source === 'billingo')) continue;
    if (e.kind === 'actual') {
      if (e.source === 'import') continue;
      const merged = (e.ext_ref || '').startsWith('merge:');
      const plan = e.link_id ? byId.get(e.link_id) : undefined;
      if (plan && plan.kind === 'plan') {
        // az összevont havi tétel (pl. bankköltség) csak a hónap lezárulta után hasonlítható
        if (merged && ymOf(e.date) >= curYm) continue;
        const diff = e.amount - plan.amount;
        if (Math.abs(diff) < DEV_MIN_FT || Math.abs(diff) < Math.abs(plan.amount) * DEV_MIN_REL) continue;
        out.push({
          id: `dev:${e.id}:${Math.round(e.amount)}`,
          kind: 'deviation',
          section: sectionOf(e.leaf_id),
          date: e.date,
          name: plan.name || e.name,
          leaf_id: e.leaf_id,
          amount: e.amount,
          plan: plan.amount,
          diff,
          entry_id: e.id,
          tx: txByActual.get(e.id),
        });
      } else if (!e.link_id) {
        if (merged && ymOf(e.date) >= curYm) continue;
        out.push({
          id: `unp:${e.id}`,
          kind: 'unplanned',
          section: sectionOf(e.leaf_id),
          date: e.date,
          name: e.name,
          leaf_id: e.leaf_id,
          amount: e.amount,
          entry_id: e.id,
          tx: txByActual.get(e.id),
        });
      }
    } else if (!e.done && !e.tentative && e.amount && addDays(e.date, OVERDUE_GRACE_DAYS) < today) {
      out.push({
        id: `due:${e.id}:${e.date}`,
        kind: 'overdue',
        section: sectionOf(e.leaf_id),
        date: e.date,
        name: e.name,
        leaf_id: e.leaf_id,
        amount: e.amount,
        plan: e.amount,
        entry_id: e.id,
      });
    }
  }
  const order: Record<FlagKind, number> = { target: -4, invoice: -3, uninvoiced: -2, underbilled: -1, deviation: 0, unplanned: 1, overdue: 2 };
  return out.filter((f) => !acked.has(f.id)).sort((a, b) => order[a.kind] - order[b.kind] || b.date.localeCompare(a.date));
}

export const FLAG_LABEL: Record<FlagKind, string> = {
  target: 'Havi eredmény a cél alatt',
  invoice: 'Új számla, nincs rá terv',
  uninvoiced: 'Nincs kiszámlázva',
  underbilled: 'Kevesebb a számla, mint a terv',
  deviation: 'Eltérés a tervtől',
  unplanned: 'Nem tervezett tétel',
  overdue: 'Elmaradt a tervhez képest',
};

/** Számlázási türelmi idő (nap) a várható számlázási nap után. */
export const INVOICE_GRACE_DAYS = 2;

/**
 * Számlázás ellenőrzése (bevétel):
 *  - nincs kiszámlázva: biztos (nem ajánlat) terv, amihez a várható számlázási nap (fizetés − határidő) után sincs Billingo-számla
 *  - kevesebb a számla: a tervhez kötött számla összege kisebb, mint a terv (magasabbnál nincs riasztás)
 */
export function billingFlags(
  entries: Entry[],
  sectionOf: (leaf: string) => Section,
  today: string,
  payDaysOf: (leaf: string) => number,
  from: string,
  ack: string[] = [],
): Flag[] {
  const acked = new Set(ack);
  const out: Flag[] = [];
  for (const e of entries) {
    if (e.kind !== 'plan' || e.amount <= 0 || sectionOf(e.leaf_id) !== 'in') continue;
    if (e.source === 'billingo') {
      const pa = e.plan_amount;
      if (pa != null && e.amount < pa && pa - e.amount >= Math.max(DEV_MIN_FT, pa * DEV_MIN_REL) && e.date >= from)
        out.push({
          id: `ub:${e.id}:${e.amount}`,
          kind: 'underbilled',
          section: 'in',
          date: e.date,
          name: e.name,
          leaf_id: e.leaf_id,
          amount: e.amount,
          plan: pa,
          diff: e.amount - pa,
          entry_id: e.id,
        });
      continue;
    }
    if (e.done || e.tentative || e.date < from) continue;
    const invoiceBy = addDays(e.date, -payDaysOf(e.leaf_id) + INVOICE_GRACE_DAYS);
    if (invoiceBy < today)
      out.push({
        id: `ui:${e.id}:${e.date}`,
        kind: 'uninvoiced',
        section: 'in',
        date: e.date,
        name: e.name,
        leaf_id: e.leaf_id,
        amount: e.amount,
        plan: e.amount,
        entry_id: e.id,
      });
  }
  return out.filter((f) => !acked.has(f.id));
}
