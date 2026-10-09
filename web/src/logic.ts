// Kliens oldali műveletek: minden módosítás egy EntryBatch-et állít elő (visszavonható).
import { addMonths, endOfMonth, ymOf } from '../../shared/model';
import { effectiveRule, payDate } from '../../shared/workdays';
import type { DataBundle, Entry, EntryBatch, Rep, Section, Series } from '../../shared/types';

export const uid = (p: string) => p + Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);

export function dateIn(ym: string, day: number): string {
  const last = Number(endOfMonth(ym).slice(8));
  return `${ym}-${String(Math.min(Math.max(1, day), last)).padStart(2, '0')}`;
}

export function shiftDate(date: string, n: number): string {
  return dateIn(addMonths(ymOf(date), n), Number(date.slice(8)));
}

export const REP: Record<Rep, string> = { once: 'Egyszeri', monthly: 'Havonta', quarterly: 'Negyedévente' };

export function signed(section: Section, abs: number) {
  return section === 'in' ? Math.abs(abs) : -Math.abs(abs);
}

export function genSeries(o: {
  leaf: string;
  section: Section;
  name: string;
  amount: number;
  startYm: string;
  count: number;
  rep: Rep;
  day: number;
  tentative?: boolean;
  /** fizetési nap szabály (első/utolsó munkanap, N-ig) – ha van, ez határozza meg a napot */
  payRule?: string | null;
}): EntryBatch {
  const sid = uid('s');
  const step = o.rep === 'quarterly' ? 3 : 1;
  const n = o.rep === 'once' ? 1 : Math.ceil(Math.min(o.count, 36) / step);
  const series: Series = { id: sid, leaf_id: o.leaf, name: o.name, rep: o.rep, day: o.day };
  const entries: Entry[] = [];
  for (let i = 0; i < n; i++)
    entries.push({
      id: uid('e'),
      kind: 'plan',
      date: o.payRule ? payDate(addMonths(o.startYm, i * step), o.payRule, o.day) : dateIn(addMonths(o.startYm, i * step), o.day),
      leaf_id: o.leaf,
      name: o.name,
      amount: signed(o.section, o.amount),
      series_id: sid,
      done: 0,
      tentative: o.tentative ? 1 : 0,
      source: 'manual',
      ext_ref: null,
      link_id: null,
      note: null,
    });
  return { series: [series], upsert: entries };
}

/** Terv késznek jelölése: kézi tény tételt hoz létre (ha bankból jön, azt a bank jóváhagyás intézi). */
export function markDone(d: DataBundle, ids: string[], val: boolean): EntryBatch {
  const byId = new Map(d.entries.map((e) => [e.id, e]));
  const upsert: Entry[] = [];
  const del: string[] = [];
  for (const id of ids) {
    const e = byId.get(id);
    if (!e || e.kind !== 'plan' || !!e.done === val) continue;
    if (val) {
      const aid = uid('a');
      const date = e.date > d.today ? d.today : e.date;
      upsert.push({ ...e, done: 1, link_id: aid });
      upsert.push({
        id: aid,
        kind: 'actual',
        date,
        leaf_id: e.leaf_id,
        name: e.name,
        amount: e.amount,
        series_id: null,
        done: 0,
        tentative: 0,
        source: 'manual',
        ext_ref: null,
        link_id: e.id,
        note: null,
      });
    } else {
      upsert.push({ ...e, done: 0, link_id: null });
      const linked = e.link_id ? byId.get(e.link_id) : null;
      if (linked && linked.source === 'manual') del.push(linked.id);
    }
  }
  return { upsert, delete: del };
}

export function shiftEntries(d: DataBundle, ids: string[], n: number): EntryBatch {
  const set = new Set(ids);
  return { upsert: d.entries.filter((e) => set.has(e.id) && !e.done).map((e) => ({ ...e, date: shiftDate(e.date, n) })) };
}

export function deleteEntries(d: DataBundle, ids: string[]): EntryBatch {
  const set = new Set(ids);
  const del = [...set];
  // a kézzel létrehozott, hozzá kapcsolt tény is törlődjön
  d.entries.forEach((e) => {
    if (set.has(e.id) && e.link_id) {
      const l = d.entries.find((x) => x.id === e.link_id);
      if (l && l.source === 'manual' && l.kind === 'actual') del.push(l.id);
    }
  });
  return { delete: del };
}

/** Sor-kulcs a kategória nézethez: sorozat, vagy (importált terveknél) kategória+név. */
export const rowKey = (e: Entry) => e.series_id || `n:${e.leaf_id}|${e.name}`;

/** Sorozat(ok) meghosszabbítása 3 hónappal az utolsó tételtől. */
export function extendRows(d: DataBundle, ids: string[]): EntryBatch {
  const keys = new Set(d.entries.filter((e) => ids.includes(e.id)).map(rowKey));
  const add: Entry[] = [];
  for (const k of keys) {
    const es = d.entries.filter((e) => e.kind === 'plan' && rowKey(e) === k);
    if (!es.length) continue;
    const last = es.reduce((a, e) => (e.date > a.date ? e : a), es[0]);
    const s = d.series.find((x) => x.id === last.series_id);
    const step = s?.rep === 'quarterly' ? 3 : 1;
    for (let i = 1; i <= Math.ceil(3 / step); i++)
      add.push({ ...last, id: uid('e'), date: shiftDate(last.date, i * step), done: 0, link_id: null, ext_ref: null, source: 'manual' });
  }
  return { upsert: add };
}

/** Egy kategória egy hónapjának értékének átírása (áttekintő táblázat cella). */
export function setCellValue(d: DataBundle, leaf: string, section: Section, ym: string, displayValue: number): EntryBatch | null {
  const list = d.entries.filter((e) => e.kind === 'plan' && !e.tentative && e.leaf_id === leaf && ymOf(e.date) === ym);
  const cur = list.reduce((s, e) => s + e.amount, 0);
  const want = section === 'in' ? displayValue : -displayValue;
  if (want === cur) return null;
  if (!list.length) {
    return {
      upsert: [
        {
          id: uid('e'),
          kind: 'plan',
          date: dateIn(ym, 10),
          leaf_id: leaf,
          name: '',
          amount: want,
          series_id: null,
          done: 0,
          tentative: 0,
          source: 'manual',
          ext_ref: null,
          link_id: null,
          note: null,
        },
      ],
    };
  }
  const first = list.find((e) => !e.done) || list[0];
  return { upsert: [{ ...first, amount: first.amount + (want - cur) }] };
}

/** A batch visszavonó párja az aktuális állapot alapján. */
export function inverseOf(d: DataBundle, b: EntryBatch): EntryBatch {
  const byId = new Map(d.entries.map((e) => [e.id, e]));
  const sById = new Map(d.series.map((s) => [s.id, s]));
  const inv: EntryBatch = { upsert: [], delete: [], series: [], deleteSeries: [] };
  for (const e of b.upsert || []) {
    const old = byId.get(e.id);
    if (old) inv.upsert!.push(old);
    else inv.delete!.push(e.id);
  }
  for (const id of b.delete || []) {
    const old = byId.get(id);
    if (old) inv.upsert!.push(old);
  }
  for (const s of b.series || []) {
    const old = sById.get(s.id);
    if (old) inv.series!.push(old);
    else inv.deleteSeries!.push(s.id);
  }
  for (const id of b.deleteSeries || []) {
    const old = sById.get(id);
    if (old) inv.series!.push(old);
  }
  return inv;
}

/** Batch alkalmazása a helyi állapotra (optimista frissítés). */
export function applyLocal(d: DataBundle, b: EntryBatch): DataBundle {
  const entries = new Map(d.entries.map((e) => [e.id, e]));
  (b.delete || []).forEach((id) => entries.delete(id));
  (b.upsert || []).forEach((e) => entries.set(e.id, e));
  const series = new Map(d.series.map((s) => [s.id, s]));
  (b.deleteSeries || []).forEach((id) => series.delete(id));
  (b.series || []).forEach((s) => series.set(s.id, s));
  return { ...d, entries: [...entries.values()].sort((a, b) => a.date.localeCompare(b.date)), series: [...series.values()] };
}

/** A kategória érvényes fizetési nap szabálya (saját, különben a csoporté). */
export function ruleOf(
  ix: { leafById: Record<string, { group_id: string; pay_rule?: string | null }>; groupById: Record<string, { pay_rule?: string | null }> },
  leafId: string | null,
) {
  if (!leafId) return null;
  const l = ix.leafById[leafId];
  return l ? effectiveRule(l, ix.groupById[l.group_id]) || null : null;
}

/** Új tétel dátuma a kategória fizetési szabálya szerint (ha a hónapban már elmúlt, a következő hónapra). */
export function ruleDateFor(ix: Parameters<typeof ruleOf>[0], leafId: string | null, date: string, today: string): string {
  const r = ruleOf(ix, leafId);
  if (!r) return date;
  let ym = ymOf(date);
  let d = payDate(ym, r, Number(date.slice(8)));
  if (d < today) {
    ym = addMonths(ym, 1);
    d = payDate(ym, r, Number(date.slice(8)));
  }
  return d;
}
