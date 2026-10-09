// Partnerstatisztika: a kategóriák alkategóriái (ügyfelek, munkatársak, szállítók) szerint.
// Tények évenként és havonta, utolsó 12 hónap, részesedés, Billingo számlák fizetési előzményei.
import { partnerKey } from './match';
import { addMonths, monthRange, ymOf } from './model';
import type { BillingoDoc, Entry, Group, Leaf, Section } from './types';

export interface PartnerInvoice {
  doc: BillingoDoc;
  /** fizetés − határidő (nap); null ha még nincs fizetve */
  lateDays: number | null;
  overdue: boolean;
}

export interface PartnerStat {
  leaf: Leaf;
  group: Group | undefined;
  section: Section;
  /** pozitív összegek (bevételnél befolyt, kiadásnál kifizetett) */
  total: number;
  last12: number;
  prev12: number;
  byYear: Record<string, number>;
  /** utolsó 24 hónap havi összegei (régi → új) */
  months: { ym: string; v: number }[];
  count: number;
  first: string | null;
  last: string | null;
  avgPayment: number;
  /** részesedés az utolsó 12 hónap azonos oldali (bevétel/kiadás) összegéből */
  share12: number;
  openPlan: number;
  nextPlan: Entry | null;
  actuals: Entry[];
  invoices: PartnerInvoice[];
  avgLate: number | null;
  lateCount: number;
  outstanding: number;
}

const days = (a: string, b: string) => Math.round((Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / 86400000);
const key = (s: string) => partnerKey(s).replace(/[^a-z0-9]/g, '');

export function partnerStats(entries: Entry[], leaves: Leaf[], groups: Group[], billingo: BillingoDoc[], today: string): PartnerStat[] {
  const gById = new Map(groups.map((g) => [g.id, g]));
  const sectionOf = (l: Leaf) => gById.get(l.group_id)?.section || 'out';
  const cur = ymOf(today);
  const m12 = new Set(monthRange(addMonths(cur, -11), cur));
  const p12 = new Set(monthRange(addMonths(cur, -23), addMonths(cur, -12)));
  const m24 = monthRange(addMonths(cur, -23), cur);
  const entryById = new Map(entries.map((e) => [e.id, e]));

  const byLeaf = new Map<string, Entry[]>();
  for (const e of entries) {
    if (!byLeaf.has(e.leaf_id)) byLeaf.set(e.leaf_id, []);
    byLeaf.get(e.leaf_id)!.push(e);
  }
  // Billingo számla → alkategória: a számlából lett terv kategóriája, különben partnernév egyezés
  const docsByLeaf = new Map<string, BillingoDoc[]>();
  const leafKeys = leaves.map((l) => ({ id: l.id, k: key(l.label) })).filter((x) => x.k.length >= 3);
  for (const d of billingo) {
    if (d.cancelled) continue;
    const viaPlan = d.plan_id ? entryById.get(d.plan_id)?.leaf_id : undefined;
    const viaRef = entries.find((e) => e.ext_ref === `billingo:${d.id}`)?.leaf_id;
    const pk = key(d.partner || '');
    const viaName = leafKeys.find((x) => pk.includes(x.k) || x.k.includes(pk))?.id;
    const lid = viaPlan || viaRef || viaName;
    if (!lid) continue;
    if (!docsByLeaf.has(lid)) docsByLeaf.set(lid, []);
    docsByLeaf.get(lid)!.push(d);
  }

  const out: PartnerStat[] = [];
  const side12: Record<Section, number> = { in: 0, out: 0 };
  for (const l of leaves) {
    const es = byLeaf.get(l.id) || [];
    const sec = sectionOf(l);
    const sign = sec === 'in' ? 1 : -1;
    const acts = es.filter((e) => e.kind === 'actual').sort((a, b) => b.date.localeCompare(a.date));
    const docs = (docsByLeaf.get(l.id) || []).sort((a, b) => (b.invoice_date || '').localeCompare(a.invoice_date || ''));
    const open = es.filter((e) => e.kind === 'plan' && !e.done && !e.tentative).sort((a, b) => a.date.localeCompare(b.date));
    if (!acts.length && !docs.length && !open.length) continue;
    const byYear: Record<string, number> = {};
    const byMonth = new Map<string, number>();
    let total = 0,
      last12 = 0,
      prev12 = 0;
    for (const e of acts) {
      const v = e.amount * sign;
      const ym = ymOf(e.date);
      total += v;
      byYear[e.date.slice(0, 4)] = (byYear[e.date.slice(0, 4)] || 0) + v;
      byMonth.set(ym, (byMonth.get(ym) || 0) + v);
      if (m12.has(ym)) last12 += v;
      if (p12.has(ym)) prev12 += v;
    }
    side12[sec] += last12;
    const invoices: PartnerInvoice[] = docs.map((d) => {
      const paid = d.payment_status === 'paid' && d.paid_date;
      return {
        doc: d,
        lateDays: paid && d.due_date ? days(d.due_date, d.paid_date!) : null,
        overdue: !paid && !!d.due_date && d.due_date < today && ['outstanding', 'expired', 'partially_paid'].includes(String(d.payment_status)),
      };
    });
    const lates = invoices.filter((i) => i.lateDays !== null).map((i) => i.lateDays!);
    out.push({
      leaf: l,
      group: gById.get(l.group_id),
      section: sec,
      total,
      last12,
      prev12,
      byYear,
      months: m24.map((ym) => ({ ym, v: byMonth.get(ym) || 0 })),
      count: acts.length,
      first: acts.length ? acts[acts.length - 1].date : null,
      last: acts.length ? acts[0].date : null,
      avgPayment: acts.length ? total / acts.length : 0,
      share12: 0,
      openPlan: open.reduce((s, e) => s + e.amount * sign, 0),
      nextPlan: open.find((e) => e.date >= today) || open[0] || null,
      actuals: acts,
      invoices,
      avgLate: lates.length ? lates.reduce((s, x) => s + x, 0) / lates.length : null,
      lateCount: lates.filter((x) => x > 0).length,
      outstanding: invoices.filter((i) => i.overdue).reduce((s, i) => s + i.doc.gross, 0),
    });
  }
  for (const p of out) p.share12 = side12[p.section] ? p.last12 / side12[p.section] : 0;
  return out;
}
