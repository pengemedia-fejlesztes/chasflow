// Munkaidő-import (Clockify-szerű havi XLS) és a fedezeti pont számítása.
// Az XLS lapjai: „YYYY.MM-Feladatok” (Tag · Projekt · Description · Idő) – ebből a ledolgozott idő hónap × projekt × feladat.
import { namesMatch } from './billingopay';
import type { Entry, Group, Leaf } from './types';

export interface WorkRow {
  ym: string;
  project: string;
  tag: string;
  minutes: number;
}

export interface Employee {
  key: string;
  name: string;
  cost_leaf_id: string | null;
}

export interface WorktimeRow extends WorkRow {
  employee: string;
}

/** Idő cella → perc: Excel-időérték (nap törtrésze, 1 felett is), „H:MM(:SS)” szöveg vagy óraszám. */
export function cellMinutes(v: unknown): number {
  if (v == null || v === '') return 0;
  if (typeof v === 'number') return Math.round(v * 24 * 60);
  if (v instanceof Date) {
    // a SheetJS dátumként adhatja az 1899-12-30-hoz viszonyított időt
    const base = Date.UTC(1899, 11, 30);
    return Math.round((v.getTime() - base) / 60000);
  }
  const s = String(v).trim();
  const m = s.match(/^(\d+):(\d{1,2})(?::(\d{1,2}))?$/);
  if (m) return Number(m[1]) * 60 + Number(m[2]) + Math.round(Number(m[3] || 0) / 60);
  const n = parseFloat(s.replace(',', '.'));
  return Number.isFinite(n) ? Math.round(n * 60) : 0;
}

/**
 * A munkafüzet „YYYY.MM-Feladatok” lapjai (sorok tömbként, fejléc: Tag, Projekt, …, Idő) → összesített sorok.
 * @param sheets lapnév → sorok (cellák tömbje)
 */
export function parseWorkSheets(sheets: Record<string, unknown[][]>): WorkRow[] {
  const acc = new Map<string, WorkRow>();
  for (const [name, rows] of Object.entries(sheets)) {
    const m = name.match(/^(\d{4})\.(\d{2})-Feladatok$/i);
    if (!m) continue;
    const ym = `${m[1]}-${m[2]}`;
    const head = (rows[0] || []).map((c) => String(c ?? '').toLowerCase());
    const ti = head.findIndex((h) => h === 'tag');
    const pi = head.findIndex((h) => h.startsWith('projekt') || h === 'project');
    // időoszlop: „Idő (H:MM)” (Excel-idő) az elsődleges; ha csak „Idő (óra)” van, az tizedes óra
    const isTime = (h: string) => h.startsWith('idő') || h.startsWith('ido') || h.startsWith('time') || h.startsWith('duration');
    const hm = head.findIndex((h) => isTime(h) && h.includes('h:mm'));
    const hours = head.findIndex((h) => isTime(h) && (h.includes('óra') || h.includes('hour') || h.includes('decimal')));
    const di = hm >= 0 ? hm : hours >= 0 ? hours : head.findIndex(isTime);
    const decimalHours = hm < 0 && di === hours;
    if (pi < 0 || di < 0) continue;
    for (const r of rows.slice(1)) {
      const project = String(r[pi] ?? '').trim();
      const minutes = decimalHours ? Math.round((parseFloat(String(r[di] ?? '').replace(',', '.')) || 0) * 60) : cellMinutes(r[di]);
      if (!project || minutes <= 0) continue;
      const tag = ti >= 0 ? String(r[ti] ?? '').trim() : '';
      const k = `${ym}|${project}|${tag}`;
      const x = acc.get(k) || { ym, project, tag, minutes: 0 };
      x.minutes += minutes;
      acc.set(k, x);
    }
  }
  return [...acc.values()].sort((a, b) => a.ym.localeCompare(b.ym) || a.project.localeCompare(b.project, 'hu'));
}

/** belső (nem számlázható) projekt: a saját cég, termékfejlesztés, projekt nélküli idő */
export const isInternalProject = (p: string) => /^(360\b|without project|egyéb|új ügyfél)/i.test(p.trim());

/** Projekt → bevételi partner (alkategória): név vagy alternatív név szerint; belső / ismeretlen → null. */
export function projectLeaf(project: string, incomeLeaves: Leaf[], aliases: Map<string, string[]>): string | null {
  if (isInternalProject(project)) return null;
  const hit = incomeLeaves.find((l) => namesMatch(project, l.label) || (aliases.get(l.id) || []).some((a) => namesMatch(project, a)));
  return hit?.id ?? null;
}

export interface ProjectMonth {
  project: string;
  leaf: string | null;
  minutes: number;
  laborCost: number;
  revenue: number;
}

export interface BreakevenMonth {
  ym: string;
  revenue: number; // összes bevétel (tény)
  expenses: number; // összes kiadás (tény), pozitív
  laborTotal: number; // a felvitt munkatársak költsége
  minutes: number; // a felvitt munkatársak összes ledolgozott ideje
  billableMinutes: number; // ügyfélprojekteken
  directLabor: number; // ügyfélprojektekre jutó munkaköltség (változó költség)
  contribution: number; // fedezet = bevétel − közvetlen munkaköltség
  ratio: number; // fedezeti hányad
  fixed: number; // fix költség = összes kiadás − közvetlen munkaköltség
  breakeven: number | null; // fedezeti pont (bevétel)
  margin: number | null; // biztonsági sáv = bevétel − fedezeti pont
  revenuePerBillableHour: number | null;
  projects: ProjectMonth[];
  people: { key: string; name: string; minutes: number; billableMinutes: number; cost: number; hourly: number | null }[];
}

/**
 * Fedezeti pont hónaponként: a munkatársak költsége (a cashflow-ban a hozzájuk rendelt kiadási alkategória tényei)
 * a ledolgozott idő arányában oszlik meg a projektek között. Az ügyfélprojektre jutó munkaköltség a változó
 * költség, minden más kiadás fix. Fedezeti pont = fix költség / fedezeti hányad.
 */
export function breakeven(o: {
  months: string[];
  entries: Entry[];
  leaves: Leaf[];
  groups: Group[];
  employees: Employee[];
  worktime: WorktimeRow[];
  aliases: Map<string, string[]>;
}): BreakevenMonth[] {
  const sectionOf = new Map(o.leaves.map((l) => [l.id, o.groups.find((g) => g.id === l.group_id)?.section]));
  const incomeLeaves = o.leaves.filter((l) => sectionOf.get(l.id) === 'in');
  const leafCache = new Map<string, string | null>();
  const leafOf = (p: string) => {
    if (!leafCache.has(p)) leafCache.set(p, projectLeaf(p, incomeLeaves, o.aliases));
    return leafCache.get(p)!;
  };
  return o.months.map((ym) => {
    const acts = o.entries.filter((e) => e.kind === 'actual' && e.date.startsWith(ym));
    const revenue = acts.filter((e) => sectionOf.get(e.leaf_id) === 'in').reduce((a, e) => a + e.amount, 0);
    const expenses = -acts.filter((e) => sectionOf.get(e.leaf_id) === 'out').reduce((a, e) => a + e.amount, 0);
    const wt = o.worktime.filter((w) => w.ym === ym);
    const projects = new Map<string, ProjectMonth>();
    const people: BreakevenMonth['people'] = [];
    let laborTotal = 0,
      minutes = 0,
      billableMinutes = 0,
      directLabor = 0;
    for (const emp of o.employees) {
      const rows = wt.filter((w) => w.employee === emp.key);
      const mins = rows.reduce((a, w) => a + w.minutes, 0);
      const cost = emp.cost_leaf_id ? -acts.filter((e) => e.leaf_id === emp.cost_leaf_id).reduce((a, e) => a + e.amount, 0) : 0;
      if (!mins && !cost) continue;
      const perMin = mins ? cost / mins : 0;
      let bill = 0;
      for (const w of rows) {
        const leaf = leafOf(w.project);
        const p = projects.get(w.project) || { project: w.project, leaf, minutes: 0, laborCost: 0, revenue: 0 };
        p.minutes += w.minutes;
        p.laborCost += w.minutes * perMin;
        projects.set(w.project, p);
        if (leaf) {
          bill += w.minutes;
          directLabor += w.minutes * perMin;
        }
      }
      laborTotal += cost;
      minutes += mins;
      billableMinutes += bill;
      people.push({ key: emp.key, name: emp.name, minutes: mins, billableMinutes: bill, cost, hourly: mins ? (cost / mins) * 60 : null });
    }
    // projektbevétel: a projekthez párosított partner bevételi tényei a hónapban (egy partnerhez több projekt is tartozhat)
    const leafRevenue = new Map<string, number>();
    for (const e of acts) if (sectionOf.get(e.leaf_id) === 'in') leafRevenue.set(e.leaf_id, (leafRevenue.get(e.leaf_id) || 0) + e.amount);
    const seenLeaf = new Set<string>();
    for (const p of projects.values())
      if (p.leaf && !seenLeaf.has(p.leaf)) {
        p.revenue = leafRevenue.get(p.leaf) || 0;
        seenLeaf.add(p.leaf);
      }
    // bevételes partner, akin ebben a hónapban senki nem dolgozott (a felvitt munkatársak közül)
    for (const [leaf, rev] of leafRevenue)
      if (!seenLeaf.has(leaf)) {
        const label = o.leaves.find((l) => l.id === leaf)?.label || leaf;
        projects.set('leaf:' + leaf, { project: label, leaf, minutes: 0, laborCost: 0, revenue: rev });
      }
    const contribution = revenue - directLabor;
    const ratio = revenue > 0 ? contribution / revenue : 0;
    const fixed = expenses - directLabor;
    const be = ratio > 0 ? fixed / ratio : null;
    return {
      ym,
      revenue,
      expenses,
      laborTotal,
      minutes,
      billableMinutes,
      directLabor: Math.round(directLabor),
      contribution: Math.round(contribution),
      ratio,
      fixed: Math.round(fixed),
      breakeven: be == null ? null : Math.round(be),
      margin: be == null ? null : Math.round(revenue - be),
      revenuePerBillableHour: billableMinutes ? Math.round(revenue / (billableMinutes / 60)) : null,
      projects: [...projects.values()]
        .map((p) => ({ ...p, laborCost: Math.round(p.laborCost) }))
        .sort((a, b) => b.revenue - a.revenue || b.minutes - a.minutes),
      people,
    };
  });
}
