// További statisztikák: likviditás (runway), bevétel-trend, költségszerkezet, ügyfélkoncentráció, kintlévőségek kora.
import { addMonths, monthRange, sumMonths, type Index } from './model';
import type { Entry, Section } from './types';

const dayDiff = (a: string, b: string) => Math.round((Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / 86400000);

function monthTotals(ix: Index, months: string[], sec: Section) {
  return months.map((ym) => {
    let v = 0;
    for (const [leaf, mm] of ix.actual) if (ix.sectionOf(leaf) === sec) v += mm.get(ym) || 0;
    return { ym, v: sec === 'in' ? v : -v };
  });
}

/** Likviditás: mai egyenleg, az elmúlt 3 lezárt hónap átlagos nettója, és hány hónapra elég a pénz. */
export function liquidity(ix: Index) {
  const last3 = monthRange(addMonths(ix.cur, -3), addMonths(ix.cur, -1));
  const last12 = monthRange(addMonths(ix.cur, -12), addMonths(ix.cur, -1));
  const inc3 = monthTotals(ix, last3, 'in').reduce((s, x) => s + x.v, 0) / 3;
  const out3 = monthTotals(ix, last3, 'out').reduce((s, x) => s + x.v, 0) / 3;
  const net3 = inc3 - out3;
  const net12 = (monthTotals(ix, last12, 'in').reduce((s, x) => s + x.v, 0) - monthTotals(ix, last12, 'out').reduce((s, x) => s + x.v, 0)) / 12;
  return {
    balance: ix.anchor,
    inc3,
    out3,
    net3,
    net12,
    /** hány hónapig fedezi az egyenleg a havi költséget, ha nem jönne bevétel */
    coverMonths: out3 > 0 && ix.anchor > 0 ? ix.anchor / out3 : null,
    /** hány hónapra elég a pénz a mostani (3 havi) mínusz ütemmel; null = nincs mínusz */
    runway: net3 < 0 ? Math.max(0, ix.anchor) / -net3 : null,
  };
}

/** Bevétel-trend: havi bevétel (tény) és 3 havi mozgóátlag, éves összevetés. */
export function revenueTrend(ix: Index, n = 24) {
  const months = monthRange(addMonths(ix.cur, -n), addMonths(ix.cur, -1));
  const inc = monthTotals(ix, monthRange(addMonths(ix.cur, -n - 2), addMonths(ix.cur, -1)), 'in');
  const rows = months.map((ym) => {
    const i = inc.findIndex((x) => x.ym === ym);
    const ma3 = (inc[i].v + inc[i - 1].v + inc[i - 2].v) / 3;
    return { ym, v: inc[i].v, ma3 };
  });
  const last12 = rows.slice(-12).reduce((s, r) => s + r.v, 0);
  const prev12 = rows.slice(-24, -12).reduce((s, r) => s + r.v, 0);
  return { rows, last12, prev12, yoy: prev12 ? (last12 - prev12) / prev12 : null };
}

/** Költségszerkezet: az elmúlt 12 hónap kiadásai csoportonként és tételenként, változás az előző 12 hónaphoz. */
export function costStructure(ix: Index) {
  const l12 = monthRange(addMonths(ix.cur, -12), addMonths(ix.cur, -1));
  const p12 = monthRange(addMonths(ix.cur, -24), addMonths(ix.cur, -13));
  const groups = new Map<string, { id: string; label: string; last12: number; prev12: number }>();
  const leaves: { id: string; label: string; group: string; last12: number; prev12: number }[] = [];
  for (const [leaf, mm] of ix.actual) {
    if (ix.sectionOf(leaf) !== 'out') continue;
    const a = -sumMonths(mm, l12),
      b = -sumMonths(mm, p12);
    if (!a && !b) continue;
    const l = ix.leafById[leaf];
    const g = ix.groupById[l?.group_id];
    const gr = groups.get(g?.id) || { id: g?.id, label: g?.label || '', last12: 0, prev12: 0 };
    gr.last12 += a;
    gr.prev12 += b;
    groups.set(g?.id, gr);
    leaves.push({ id: leaf, label: l?.label || leaf, group: g?.label || '', last12: a, prev12: b });
  }
  const total = [...groups.values()].reduce((s, g) => s + g.last12, 0);
  return {
    total,
    groups: [...groups.values()].sort((a, b) => b.last12 - a.last12),
    leaves: leaves.sort((a, b) => b.last12 - a.last12),
  };
}

/** Ügyfélkoncentráció: TOP 1/3/5 részesedés és HHI (0–10 000) az elmúlt 12 hónap bevételéből. */
export function concentration(shares: { name: string; v: number }[]) {
  const list = shares.filter((s) => s.v > 0).sort((a, b) => b.v - a.v);
  const total = list.reduce((s, x) => s + x.v, 0) || 1;
  const top = (n: number) => list.slice(0, n).reduce((s, x) => s + x.v, 0) / total;
  const hhi = Math.round(list.reduce((s, x) => s + Math.pow((x.v / total) * 100, 2), 0));
  return { list: list.map((x) => ({ ...x, share: x.v / total })), top1: top(1), top3: top(3), top5: top(5), hhi, count: list.length };
}

/** Kintlévőségek kora: lejárt, még nyitott bevételi tételek korosztályai (napok a határidő óta). */
export function receivablesAging(entries: Entry[], sectionOf: (leaf: string) => Section, today: string) {
  const buckets = [
    { key: 'notdue', label: 'Még nem esedékes (30 napon belül)', min: -30, max: -1 },
    { key: 'd30', label: '1–30 napja lejárt', min: 1, max: 30 },
    { key: 'd60', label: '31–60 napja lejárt', min: 31, max: 60 },
    { key: 'd90', label: '61–90 napja lejárt', min: 61, max: 90 },
    { key: 'old', label: '90 napnál régebben lejárt', min: 91, max: Infinity },
  ].map((b) => ({ ...b, sum: 0, items: [] as (Entry & { days: number })[] }));
  for (const e of entries) {
    if (e.kind !== 'plan' || e.done || e.tentative || sectionOf(e.leaf_id) !== 'in' || !e.amount) continue;
    const d = dayDiff(e.date, today);
    const b = buckets.find((x) => d >= x.min && d <= x.max) || (d === 0 ? buckets[0] : undefined);
    if (!b) continue;
    b.sum += e.amount;
    b.items.push({ ...e, days: d });
  }
  buckets.forEach((b) => b.items.sort((a, c) => c.days - a.days));
  const overdue = buckets.slice(1).reduce((s, b) => s + b.sum, 0);
  return { buckets, overdue };
}
