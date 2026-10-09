// Partnerstatisztika. Egy partner = azonos nevű alkategóriák (bevételi és kiadási oldalon is):
// múltbeli tények, várható tételek (terv, ajánlat), összetevők, számlázási nevek, Billingo számlák és késések.
import { partnerKey } from './match';
import { addMonths, monthRange, ymOf } from './model';
import type { BillingoDoc, Entry, Group, Leaf, Section } from './types';

export interface PartnerInvoice {
  doc: BillingoDoc;
  /** fizetés − határidő (nap); null ha még nincs fizetve */
  lateDays: number | null;
  overdue: boolean;
}

export interface SideStat {
  total: number;
  last12: number;
  prev12: number;
  count: number;
  share12: number;
  openPlan: number;
  offers: number;
}

export interface Component {
  name: string;
  section: Section;
  total: number;
  count: number;
  last: string;
}

export interface PartnerStat {
  key: string;
  name: string;
  leaves: Leaf[];
  groups: Group[];
  sides: Partial<Record<Section, SideStat>>;
  /** előjeles (bevétel +, kiadás −) havi összeg, utolsó 24 hónap */
  months: { ym: string; inc: number; out: number }[];
  byYear: Record<string, { inc: number; out: number }>;
  first: string | null;
  last: string | null;
  past: Entry[];
  future: Entry[];
  pastComponents: Component[];
  futureComponents: Component[];
  billingNames: { name: string; source: 'Billingo' | 'bank'; n: number }[];
  invoices: PartnerInvoice[];
  avgLate: number | null;
  lateCount: number;
  outstanding: number;
}

const days = (a: string, b: string) => Math.round((Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / 86400000);
const squash = (s: string) => partnerKey(s).replace(/[^a-z0-9]/g, '');
/** A partner azonosítója a Cash-ben használt névből. */
export const partnerIdOf = squash;

function components(es: Entry[], sectionOf: (leaf: string) => Section): Component[] {
  const m = new Map<string, Component>();
  for (const e of es) {
    const sec = sectionOf(e.leaf_id);
    const name = (e.name || '').replace(/\s*·\s*Penge.*$/i, '').trim() || '(név nélkül)';
    const k = sec + '|' + name.toLowerCase();
    const c = m.get(k) || { name, section: sec, total: 0, count: 0, last: e.date };
    c.total += Math.abs(e.amount);
    c.count++;
    if (e.date > c.last) c.last = e.date;
    m.set(k, c);
  }
  return [...m.values()].sort((a, b) => b.total - a.total);
}

export function partnerStats(
  entries: Entry[],
  leaves: Leaf[],
  groups: Group[],
  billingo: BillingoDoc[],
  today: string,
  bankNames: { leaf_id: string; partner: string; n: number }[] = [],
): PartnerStat[] {
  const gById = new Map(groups.map((g) => [g.id, g]));
  const secOfLeaf = new Map(leaves.map((l) => [l.id, (gById.get(l.group_id)?.section || 'out') as Section]));
  const sectionOf = (id: string) => secOfLeaf.get(id) || 'out';
  const cur = ymOf(today);
  const m12 = new Set(monthRange(addMonths(cur, -11), cur));
  const p12 = new Set(monthRange(addMonths(cur, -23), addMonths(cur, -12)));
  const m24 = monthRange(addMonths(cur, -23), cur);
  const entryById = new Map(entries.map((e) => [e.id, e]));

  // partner = azonos (normalizált) nevű alkategóriák
  const byKey = new Map<string, Leaf[]>();
  for (const l of leaves) {
    const k = squash(l.label) || l.id;
    if (!byKey.has(k)) byKey.set(k, []);
    byKey.get(k)!.push(l);
  }
  const keyOfLeaf = new Map<string, string>();
  for (const [k, ls] of byKey) ls.forEach((l) => keyOfLeaf.set(l.id, k));

  const byLeaf = new Map<string, Entry[]>();
  for (const e of entries) {
    if (!byLeaf.has(e.leaf_id)) byLeaf.set(e.leaf_id, []);
    byLeaf.get(e.leaf_id)!.push(e);
  }
  // Billingo számla → partner: a számlából lett terv kategóriája, különben partnernév egyezés
  const docsByKey = new Map<string, BillingoDoc[]>();
  const keys = [...byKey.keys()].filter((k) => k.length >= 3);
  for (const d of billingo) {
    if (d.cancelled) continue;
    const viaPlan = d.plan_id ? entryById.get(d.plan_id)?.leaf_id : undefined;
    const viaRef = entries.find((e) => e.ext_ref === `billingo:${d.id}`)?.leaf_id;
    const pk = squash(d.partner || '');
    const k =
      (viaPlan && keyOfLeaf.get(viaPlan)) || (viaRef && keyOfLeaf.get(viaRef)) || keys.find((x) => pk.includes(x) || (pk.length >= 3 && x.includes(pk)));
    if (!k) continue;
    if (!docsByKey.has(k)) docsByKey.set(k, []);
    docsByKey.get(k)!.push(d);
  }

  const out: PartnerStat[] = [];
  const side12: Record<Section, number> = { in: 0, out: 0 };
  for (const [key, ls] of byKey) {
    const es = ls.flatMap((l) => byLeaf.get(l.id) || []);
    const docs = (docsByKey.get(key) || []).sort((a, b) => (b.invoice_date || '').localeCompare(a.invoice_date || ''));
    const past = es.filter((e) => e.kind === 'actual').sort((a, b) => b.date.localeCompare(a.date));
    const future = es.filter((e) => e.kind === 'plan' && !e.done).sort((a, b) => a.date.localeCompare(b.date));
    if (!past.length && !future.length && !docs.length) continue;
    const sides: Partial<Record<Section, SideStat>> = {};
    const byYear: Record<string, { inc: number; out: number }> = {};
    const byMonth = new Map<string, { inc: number; out: number }>();
    for (const e of past) {
      const sec = sectionOf(e.leaf_id);
      const v = Math.abs(e.amount) * Math.sign(sec === 'in' ? e.amount : -e.amount);
      const s = (sides[sec] ||= { total: 0, last12: 0, prev12: 0, count: 0, share12: 0, openPlan: 0, offers: 0 });
      const ym = ymOf(e.date);
      s.total += v;
      s.count++;
      if (m12.has(ym)) s.last12 += v;
      if (p12.has(ym)) s.prev12 += v;
      const y = (byYear[e.date.slice(0, 4)] ||= { inc: 0, out: 0 });
      const mm = byMonth.get(ym) || { inc: 0, out: 0 };
      if (sec === 'in') ((y.inc += v), (mm.inc += v));
      else ((y.out += v), (mm.out += v));
      byMonth.set(ym, mm);
    }
    for (const e of future) {
      const sec = sectionOf(e.leaf_id);
      const s = (sides[sec] ||= { total: 0, last12: 0, prev12: 0, count: 0, share12: 0, openPlan: 0, offers: 0 });
      const v = sec === 'in' ? e.amount : -e.amount;
      if (e.tentative) s.offers += v;
      else s.openPlan += v;
    }
    for (const sec of ['in', 'out'] as Section[]) if (sides[sec]) side12[sec] += sides[sec]!.last12;
    const invoices: PartnerInvoice[] = docs.map((d) => {
      const paid = d.payment_status === 'paid' && d.paid_date;
      return {
        doc: d,
        lateDays: paid && d.due_date ? days(d.due_date, d.paid_date!) : null,
        overdue: !paid && !!d.due_date && d.due_date < today && ['outstanding', 'expired', 'partially_paid'].includes(String(d.payment_status)),
      };
    });
    const lates = invoices.filter((i) => i.lateDays !== null).map((i) => i.lateDays!);
    // számlázási nevek: Billingo (cégnév a számlán) és a bank (utaló / kedvezményezett neve)
    const bn = new Map<string, { name: string; source: 'Billingo' | 'bank'; n: number }>();
    for (const d of docs) if (d.partner) bn.set('b|' + d.partner, { name: d.partner, source: 'Billingo', n: (bn.get('b|' + d.partner)?.n || 0) + 1 });
    for (const r of bankNames)
      if (ls.some((l) => l.id === r.leaf_id)) bn.set('k|' + r.partner, { name: r.partner, source: 'bank', n: (bn.get('k|' + r.partner)?.n || 0) + r.n });
    // a leggyakrabban használt alkategória neve a partner neve
    const name = [...ls].sort((a, b) => (byLeaf.get(b.id)?.length || 0) - (byLeaf.get(a.id)?.length || 0))[0].label;
    out.push({
      key,
      name,
      leaves: ls,
      groups: [...new Set(ls.map((l) => l.group_id))].map((g) => gById.get(g)!).filter(Boolean),
      sides,
      months: m24.map((ym) => ({ ym, inc: byMonth.get(ym)?.inc || 0, out: byMonth.get(ym)?.out || 0 })),
      byYear,
      first: past.length ? past[past.length - 1].date : null,
      last: past.length ? past[0].date : null,
      past,
      future,
      pastComponents: components(past, sectionOf),
      futureComponents: components(future, sectionOf),
      billingNames: [...bn.values()].sort((a, b) => b.n - a.n),
      invoices,
      avgLate: lates.length ? lates.reduce((s, x) => s + x, 0) / lates.length : null,
      lateCount: lates.filter((x) => x > 0).length,
      outstanding: invoices.filter((i) => i.overdue).reduce((s, i) => s + i.doc.gross, 0),
    });
  }
  for (const p of out)
    for (const sec of ['in', 'out'] as Section[]) if (p.sides[sec] && side12[sec]) p.sides[sec]!.share12 = p.sides[sec]!.last12 / side12[sec];
  return out;
}
