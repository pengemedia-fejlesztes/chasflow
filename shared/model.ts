// Cashflow számítások: havi/éves mátrix, egyenleg (tény + előrejelzés), becslés.
import type { DataBundle, Entry, Group, Leaf, Section } from './types';

export const MS = ['Jan.', 'Feb.', 'Márc.', 'Ápr.', 'Máj.', 'Jún.', 'Júl.', 'Aug.', 'Szept.', 'Okt.', 'Nov.', 'Dec.'];
export const MSL = ['január', 'február', 'március', 'április', 'május', 'június', 'július', 'augusztus', 'szeptember', 'október', 'november', 'december'];

export const fmt = (n: number) => Math.round(n).toLocaleString('hu-HU');
export const fmtM = (n: number) => (n / 1e6).toLocaleString('hu-HU', { maximumFractionDigits: 1 }) + ' M';
export const fmtK = (n: number) => (Math.abs(n) >= 1e6 ? (n / 1e6).toLocaleString('hu-HU', { maximumFractionDigits: 1 }) + 'M' : Math.round(n / 1e3) + 'e');

// ---------- hónap segédfüggvények ----------
export const ymOf = (date: string) => date.slice(0, 7);
export function addMonths(ym: string, n: number): string {
  const [y, m] = ym.split('-').map(Number);
  const t = y * 12 + (m - 1) + n;
  return `${Math.floor(t / 12)}-${String((t % 12) + 1).padStart(2, '0')}`;
}
export function monthDiff(a: string, b: string): number {
  const [ya, ma] = a.split('-').map(Number);
  const [yb, mb] = b.split('-').map(Number);
  return ya * 12 + ma - (yb * 12 + mb);
}
export function monthRange(from: string, to: string): string[] {
  const out: string[] = [];
  for (let m = from; monthDiff(to, m) >= 0 && out.length < 240; m = addMonths(m, 1)) out.push(m);
  return out;
}
export function endOfMonth(ym: string): string {
  const [y, m] = ym.split('-').map(Number);
  const d = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return `${ym}-${String(d).padStart(2, '0')}`;
}
export const monthLabel = (ym: string) => MS[Number(ym.slice(5, 7)) - 1];
export const monthLong = (ym: string) => `${ym.slice(0, 4)}. ${MSL[Number(ym.slice(5, 7)) - 1]}`;

// ---------- index ----------
type LeafMonth = Map<string, Map<string, number>>;

export interface Index {
  today: string;
  cur: string; // aktuális hónap YYYY-MM
  groups: Group[];
  leaves: Leaf[];
  groupById: Record<string, Group>;
  leafById: Record<string, Leaf>;
  sectionOf: (leafId: string) => Section;
  entries: Entry[];
  actual: LeafMonth; // tény, előjeles
  plan: LeafMonth; // minden biztos terv (nyitott + kész), előjeles
  openPlan: LeafMonth; // nyitott biztos terv
  offer: LeafMonth; // nyitott ajánlat (tentative)
  firstActual: string | null;
  lastActual: string | null;
  lastPlanMonth: Record<string, string>; // leaf → utolsó tervezett hónap
  sumActualToToday: number;
  opening: number;
  bankBalance: number | null;
  computedBalance: number;
  anchor: number; // mai egyenleg (bank, ha elérhető)
  anchorSource: 'bank' | 'computed';
}

function add(map: LeafMonth, leaf: string, ym: string, v: number) {
  let m = map.get(leaf);
  if (!m) map.set(leaf, (m = new Map()));
  m.set(ym, (m.get(ym) || 0) + v);
}

export function buildIndex(d: Pick<DataBundle, 'groups' | 'leaves' | 'entries' | 'accounts' | 'settings' | 'today'>): Index {
  const groupById: Record<string, Group> = {};
  d.groups.forEach((g) => (groupById[g.id] = g));
  const leafById: Record<string, Leaf> = {};
  d.leaves.forEach((l) => (leafById[l.id] = l));
  const sectionOf = (id: string): Section => groupById[leafById[id]?.group_id]?.section ?? 'out';
  const actual: LeafMonth = new Map(),
    plan: LeafMonth = new Map(),
    openPlan: LeafMonth = new Map(),
    offer: LeafMonth = new Map();
  const lastPlanMonth: Record<string, string> = {};
  let firstActual: string | null = null,
    lastActual: string | null = null,
    sumActualToToday = 0;
  for (const e of d.entries) {
    const ym = ymOf(e.date);
    if (e.kind === 'actual') {
      add(actual, e.leaf_id, ym, e.amount);
      if (!firstActual || e.date < firstActual) firstActual = e.date;
      if (!lastActual || e.date > lastActual) lastActual = e.date;
      if (e.date <= d.today) sumActualToToday += e.amount;
    } else if (e.tentative) {
      if (!e.done) add(offer, e.leaf_id, ym, e.amount);
    } else {
      add(plan, e.leaf_id, ym, e.amount);
      if (!e.done) add(openPlan, e.leaf_id, ym, e.amount);
      if (!lastPlanMonth[e.leaf_id] || ym > lastPlanMonth[e.leaf_id]) lastPlanMonth[e.leaf_id] = ym;
    }
  }
  const opening = Number(d.settings.opening_balance || 0) || 0;
  const accts = d.accounts.filter((a) => a.active && a.balance != null && (a.currency || 'HUF') === 'HUF');
  const bankBalance = accts.length ? accts.reduce((s, a) => s + (a.balance || 0), 0) : null;
  const computedBalance = opening + sumActualToToday;
  return {
    today: d.today,
    cur: ymOf(d.today),
    groups: [...d.groups].sort((a, b) => (a.section === b.section ? a.sort - b.sort || a.label.localeCompare(b.label, 'hu') : a.section === 'in' ? -1 : 1)),
    leaves: [...d.leaves].sort((a, b) => a.sort - b.sort || a.label.localeCompare(b.label, 'hu')),
    groupById,
    leafById,
    sectionOf,
    entries: d.entries,
    actual,
    plan,
    openPlan,
    offer,
    firstActual,
    lastActual,
    lastPlanMonth,
    sumActualToToday,
    opening,
    bankBalance,
    computedBalance,
    anchor: bankBalance ?? computedBalance,
    anchorSource: bankBalance != null ? 'bank' : 'computed',
  };
}

const sumMonths = (m: Map<string, number> | undefined, months: string[]) => {
  if (!m) return 0;
  let s = 0;
  for (const ym of months) s += m.get(ym) || 0;
  return s;
};

// ---------- becslés ----------
/**
 * Becslés a korábbi tények alapján: az elmúlt 12 lezárt hónap átlaga azokra a kategóriákra,
 * amelyek rendszeresek (legalább 6 hónapban volt mozgás, és az utolsó 3 hónapban is).
 * Csak ott becsül, ahol nincs terv: a kategória utolsó tervezett hónapja utáni hónapokra.
 */
export function buildEstimates(ix: Index, horizon: string): LeafMonth {
  const est: LeafMonth = new Map();
  const last12 = monthRange(addMonths(ix.cur, -12), addMonths(ix.cur, -1));
  const last3 = last12.slice(-3);
  for (const [leaf, months] of ix.actual) {
    if (ix.leafById[leaf]?.archived) continue;
    const active = last12.filter((ym) => (months.get(ym) || 0) !== 0).length;
    const recent = last3.some((ym) => (months.get(ym) || 0) !== 0);
    if (active < 6 || !recent) continue;
    const avg = Math.round(sumMonths(months, last12) / 12);
    if (!avg) continue;
    const lp = ix.lastPlanMonth[leaf];
    const start = addMonths(lp && lp >= ix.cur ? lp : ix.cur, 1);
    for (const ym of monthRange(start, horizon)) add(est, leaf, ym, avg);
  }
  return est;
}

// ---------- szűrők, oszlopok ----------
export type Mode = 'auto' | 'actual' | 'plan';
export interface Filters {
  from: string;
  to: string;
  mode: Mode;
  section: 'all' | Section;
  groupId: string | null;
  includeOffers: boolean;
  estimate: boolean;
  search: string;
  granularity: 'month' | 'year';
}

export function defaultFilters(today: string): Filters {
  const cur = ymOf(today);
  return {
    from: cur,
    to: addMonths(cur, 7),
    mode: 'auto',
    section: 'all',
    groupId: null,
    includeOffers: false,
    estimate: true,
    search: '',
    granularity: 'month',
  };
}

export interface Column {
  key: string;
  label: string;
  sub: string;
  kind: 'actual' | 'plan';
  months: string[];
  last: string; // utolsó hónap
  current: boolean;
}

export function buildColumns(f: Filters, cur: string): Column[] {
  const cols: Column[] = [];
  if (f.granularity === 'year') {
    const y0 = Number(f.from.slice(0, 4)),
      y1 = Number(f.to.slice(0, 4));
    const cy = Number(cur.slice(0, 4));
    for (let y = y0; y <= y1; y++) {
      const months = monthRange(`${y}-01`, `${y}-12`);
      const kind = f.mode === 'plan' ? 'plan' : f.mode === 'actual' ? 'actual' : y < cy ? 'actual' : y > cy ? 'plan' : 'actual';
      if (f.mode === 'auto' && y === cy) {
        cols.push({ key: `${y}a`, label: String(y), sub: 'tény eddig', kind: 'actual', months, last: `${y}-12`, current: true });
        cols.push({ key: `${y}p`, label: String(y), sub: 'tény + terv', kind: 'plan', months, last: `${y}-12`, current: true });
      } else cols.push({ key: `${y}${kind[0]}`, label: String(y), sub: kind === 'actual' ? 'tény' : 'terv', kind, months, last: `${y}-12`, current: y === cy });
    }
    return cols;
  }
  for (const ym of monthRange(f.from, f.to)) {
    const label = monthLabel(ym),
      year = ym.slice(0, 4);
    const isCur = ym === cur;
    if (f.mode === 'actual') {
      if (monthDiff(ym, cur) <= 0) cols.push({ key: ym + 'a', label, sub: year + ' · tény', kind: 'actual', months: [ym], last: ym, current: isCur });
    } else if (f.mode === 'plan') {
      cols.push({ key: ym + 'p', label, sub: year + ' · terv', kind: 'plan', months: [ym], last: ym, current: isCur });
    } else if (isCur) {
      cols.push({ key: ym + 'a', label: label + ' tény', sub: year + ' · bankból', kind: 'actual', months: [ym], last: ym, current: true });
      cols.push({ key: ym + 'p', label: label + ' terv', sub: year, kind: 'plan', months: [ym], last: ym, current: true });
    } else if (monthDiff(ym, cur) < 0) {
      cols.push({ key: ym + 'a', label, sub: year + ' · tény', kind: 'actual', months: [ym], last: ym, current: false });
    } else {
      cols.push({ key: ym + 'p', label, sub: year, kind: 'plan', months: [ym], last: ym, current: false });
    }
  }
  return cols;
}

// ---------- mátrix ----------
export interface Cell {
  v: number; // megjelenítési érték (bevétel +, kiadás + ; visszatérítés −)
  est: number; // ebből becslés
  offer: number; // ebből ajánlat
}

export interface MatrixRow {
  type: 'section' | 'group' | 'leaf';
  id: string;
  label: string;
  section: Section;
  groupId?: string;
  cells: Cell[];
  total: number;
}

export interface Matrix {
  columns: Column[];
  rows: MatrixRow[];
  net: number[]; // havi cashflow (szűrt kategóriákra), előjeles
  balance: number[]; // záró egyenleg (teljes)
  balanceKind: ('actual' | 'proj')[];
  filtered: boolean;
}

/** Egy kategória egy oszlopának előjeles értéke. */
function leafValue(ix: Index, leaf: string, col: Column, f: Filters, est: LeafMonth): { v: number; est: number; offer: number } {
  if (col.kind === 'actual') return { v: sumMonths(ix.actual.get(leaf), col.months), est: 0, offer: 0 };
  // terv oszlop: múltbeli hónapra (éves nézet) a tényt, jövőre a tervet + becslést
  let v = 0,
    e = 0,
    o = 0;
  for (const ym of col.months) {
    if (monthDiff(ym, ix.cur) < 0 && f.granularity === 'year') {
      v += ix.actual.get(leaf)?.get(ym) || 0;
      continue;
    }
    if (f.granularity === 'year' && ym === ix.cur) {
      // aktuális hónap éves nézetben: tény + nyitott terv
      v += (ix.actual.get(leaf)?.get(ym) || 0) + (ix.openPlan.get(leaf)?.get(ym) || 0);
    } else v += ix.plan.get(leaf)?.get(ym) || 0;
    if (f.includeOffers) {
      const ov = ix.offer.get(leaf)?.get(ym) || 0;
      v += ov;
      o += ov;
    }
    if (f.estimate && monthDiff(ym, ix.cur) > 0) {
      const ev = est.get(leaf)?.get(ym) || 0;
      v += ev;
      e += ev;
    }
  }
  return { v, est: e, offer: o };
}

/** Előrejelzett záró egyenleg hónaponként (cur..to). */
export function projection(ix: Index, f: Pick<Filters, 'includeOffers' | 'estimate'>, to: string, est: LeafMonth): Map<string, number> {
  const out = new Map<string, number>();
  const minOverdue = addMonths(ix.cur, -4);
  let bal = ix.anchor;
  // aktuális hónap: minden nyitott terv a hónap végéig (a lejárt, még nyitott tételekkel együtt)
  // a mai napnál későbbi dátumú tények (pl. előre rögzített kézi tétel) a saját hónapjukban számítanak
  const futureActual = new Map<string, number>();
  for (const e of ix.entries) {
    if (e.kind === 'actual') {
      if (e.date > ix.today) futureActual.set(ymOf(e.date), (futureActual.get(ymOf(e.date)) || 0) + e.amount);
      continue;
    }
    if (e.done) continue;
    if (e.tentative && !f.includeOffers) continue;
    const ym = ymOf(e.date);
    if (ym <= ix.cur && ym >= minOverdue) bal += e.amount;
  }
  bal += futureActual.get(ix.cur) || 0;
  out.set(ix.cur, bal);
  for (const ym of monthRange(addMonths(ix.cur, 1), to)) {
    bal += futureActual.get(ym) || 0;
    for (const [, m] of ix.openPlan) bal += m.get(ym) || 0;
    if (f.includeOffers) for (const [, m] of ix.offer) bal += m.get(ym) || 0;
    if (f.estimate) for (const [, m] of est) bal += m.get(ym) || 0;
    out.set(ym, bal);
  }
  return out;
}

/** Tényleges záró egyenleg egy múltbeli hónap végén: mai egyenleg − az azóta történt tények. */
export function actualBalanceAt(ix: Index, ym: string): number {
  const end = endOfMonth(ym);
  let after = 0;
  for (const e of ix.entries) if (e.kind === 'actual' && e.date > end && e.date <= ix.today) after += e.amount;
  return ix.anchor - after;
}

function matchesSearch(ix: Index, leaf: Leaf, q: string): boolean {
  if (!q) return true;
  const n = q.toLowerCase();
  if (leaf.label.toLowerCase().includes(n)) return true;
  const g = ix.groupById[leaf.group_id];
  if (g && g.label.toLowerCase().includes(n)) return true;
  return ix.entries.some((e) => e.leaf_id === leaf.id && e.name.toLowerCase().includes(n));
}

export function buildMatrix(ix: Index, f: Filters): Matrix {
  const columns = buildColumns(f, ix.cur);
  const horizon = columns.length ? columns[columns.length - 1].last : ix.cur;
  const est = f.estimate ? buildEstimates(ix, monthDiff(horizon, ix.cur) > 0 ? horizon : ix.cur) : new Map();
  const rows: MatrixRow[] = [];
  const net = columns.map(() => 0);
  const filtered = f.section !== 'all' || !!f.groupId || !!f.search;
  for (const section of ['in', 'out'] as Section[]) {
    if (f.section !== 'all' && f.section !== section) continue;
    const sign = section === 'in' ? 1 : -1;
    const secRow: MatrixRow = {
      type: 'section',
      id: section,
      label: section === 'in' ? 'Bevétel' : 'Kiadás',
      section,
      cells: columns.map(() => ({ v: 0, est: 0, offer: 0 })),
      total: 0,
    };
    const secChildren: MatrixRow[] = [];
    for (const g of ix.groups.filter((g) => g.section === section)) {
      if (f.groupId && f.groupId !== g.id) continue;
      const gRow: MatrixRow = { type: 'group', id: g.id, label: g.label, section, cells: columns.map(() => ({ v: 0, est: 0, offer: 0 })), total: 0 };
      const leafRows: MatrixRow[] = [];
      for (const l of ix.leaves.filter((l) => l.group_id === g.id)) {
        if (!matchesSearch(ix, l, f.search)) continue;
        const cells = columns.map((c) => {
          const r = leafValue(ix, l.id, c, f, est);
          return { v: r.v * sign, est: r.est * sign, offer: r.offer * sign };
        });
        // csak az aktív szűrőkhöz tartozó (nem üres) sorok
        if (!cells.some((c) => Math.round(c.v) !== 0)) continue;
        const lr: MatrixRow = { type: 'leaf', id: l.id, label: l.label, section, groupId: g.id, cells, total: 0 };
        lr.total = cells.reduce((s, c) => s + c.v, 0);
        cells.forEach((c, i) => {
          gRow.cells[i].v += c.v;
          gRow.cells[i].est += c.est;
          gRow.cells[i].offer += c.offer;
          net[i] += c.v * sign;
        });
        leafRows.push(lr);
      }
      if (!leafRows.length) continue;
      gRow.total = gRow.cells.reduce((s, c) => s + c.v, 0);
      gRow.cells.forEach((c, i) => {
        secRow.cells[i].v += c.v;
        secRow.cells[i].est += c.est;
        secRow.cells[i].offer += c.offer;
      });
      secChildren.push(gRow, ...leafRows);
    }
    if (!secChildren.length) continue;
    secRow.total = secRow.cells.reduce((s, c) => s + c.v, 0);
    rows.push(secRow, ...secChildren);
  }
  const proj = projection(ix, f, monthDiff(horizon, ix.cur) > 0 ? horizon : ix.cur, est);
  const balance: number[] = [];
  const balanceKind: ('actual' | 'proj')[] = [];
  for (const c of columns) {
    const ym = c.last;
    if (c.kind === 'actual' || monthDiff(ym, ix.cur) < 0) {
      balance.push(monthDiff(ym, ix.cur) >= 0 ? ix.anchor : actualBalanceAt(ix, ym));
      balanceKind.push('actual');
    } else {
      balance.push(proj.get(ym) ?? ix.anchor);
      balanceKind.push('proj');
    }
  }
  return { columns, rows, net, balance, balanceKind, filtered };
}

// ---------- összefoglalók ----------
export interface Outlook {
  months: { ym: string; bal: number; net: number; inc: number; exp: number }[];
  next12: { inc: number; exp: number; net: number; endBal: number; minBal: number; minYm: string };
  last12: { inc: number; exp: number; net: number };
  overdueOpen: Entry[];
}

/** 12 hónapos előretekintés + az elmúlt 12 hónap tényei. */
export function outlook(ix: Index, f: Pick<Filters, 'includeOffers' | 'estimate'>): Outlook {
  const to = addMonths(ix.cur, 12);
  const est = f.estimate ? buildEstimates(ix, to) : new Map();
  const proj = projection(ix, f, to, est);
  const months: Outlook['months'] = [];
  for (const ym of monthRange(ix.cur, to)) {
    let inc = 0,
      exp = 0;
    const addv = (v: number) => (v >= 0 ? (inc += v) : (exp -= v));
    const add2 = (map: LeafMonth) => {
      for (const [, m] of map) {
        const v = m.get(ym) || 0;
        if (v) addv(v);
      }
    };
    if (ym === ix.cur) {
      add2(ix.actual);
      add2(ix.openPlan);
    } else add2(ix.openPlan);
    if (f.includeOffers) add2(ix.offer);
    if (f.estimate && ym !== ix.cur) add2(est);
    months.push({ ym, bal: proj.get(ym) || 0, net: inc - exp, inc, exp });
  }
  const fut = months.slice(1);
  let minBal = Infinity,
    minYm = ix.cur;
  months.forEach((m) => {
    if (m.bal < minBal) {
      minBal = m.bal;
      minYm = m.ym;
    }
  });
  const last = monthRange(addMonths(ix.cur, -12), addMonths(ix.cur, -1));
  let li = 0,
    le = 0;
  for (const [, m] of ix.actual)
    for (const ym of last) {
      const v = m.get(ym) || 0;
      if (v >= 0) li += v;
      else le -= v;
    }
  const overdueOpen = ix.entries.filter((e) => e.kind === 'plan' && !e.done && !e.tentative && e.date < ix.today).sort((a, b) => a.date.localeCompare(b.date));
  return {
    months,
    next12: {
      inc: fut.reduce((s, m) => s + m.inc, 0),
      exp: fut.reduce((s, m) => s + m.exp, 0),
      net: fut.reduce((s, m) => s + m.net, 0),
      endBal: months[months.length - 1].bal,
      minBal,
      minYm,
    },
    last12: { inc: li, exp: le, net: li - le },
    overdueOpen,
  };
}
