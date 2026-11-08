// Munkaidő-import (Clockify-szerű havi XLS) és a fedezeti pont számítása.
// Az XLS lapjai: „YYYY.MM-Feladatok” (Tag · Projekt · Description · Idő) – ebből a ledolgozott idő hónap × projekt × feladat.
import { namesMatch } from './billingopay';
import { partnerIdOf } from './partners';
import type { Entry, Group, Leaf } from './types';

export interface WorkRow {
  ym: string;
  project: string;
  tag: string;
  minutes: number;
  /** a sor összege euróban (Feladatok lap „Összeg (EUR)” oszlop) – ennek arányában oszlik meg a munkaköltség */
  eur?: number;
}

export interface Employee {
  key: string;
  name: string;
  cost_leaf_id: string | null;
  /** elszámoló Google Sheet link (nyilvános megtekintő link) */
  sheet_url?: string | null;
}

/** Google Sheet link → táblázat-azonosító (null, ha nem Google Sheet link). */
export function sheetIdOf(url: string | null | undefined): string | null {
  const m = String(url || '').match(/^https:\/\/docs\.google\.com\/spreadsheets\/d\/([\w-]{20,})/);
  return m ? m[1] : null;
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
    const ei = head.findIndex((h) => (h.startsWith('összeg') || h.startsWith('osszeg') || h.startsWith('amount')) && h.includes('eur'));
    if (pi < 0 || di < 0) continue;
    for (const r of rows.slice(1)) {
      const project = String(r[pi] ?? '').trim();
      const minutes = decimalHours ? Math.round((parseFloat(String(r[di] ?? '').replace(',', '.')) || 0) * 60) : cellMinutes(r[di]);
      if (!project || minutes <= 0) continue;
      const tag = ti >= 0 ? String(r[ti] ?? '').trim() : '';
      // az összesítő sor („Munkaidő összesen”) nem projekt – különben a bontás duplán számítana
      if (/(^|\s)(összesen|osszesen|total|sum)\b/i.test(project) || /(^|\s)(összesen|osszesen|total)\b/i.test(tag)) continue;
      const eur = ei >= 0 ? parseFloat(String(r[ei] ?? '').replace(',', '.')) || 0 : 0;
      const k = `${ym}|${project}|${tag}`;
      const x: WorkRow = acc.get(k) || { ym, project, tag, minutes: 0, ...(ei >= 0 ? { eur: 0 } : {}) };
      x.minutes += minutes;
      if (ei >= 0) x.eur = Math.round(((x.eur || 0) + eur) * 100) / 100;
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
  // „MrBIG” = „Mr. Big”: írásjel, szóköz, ékezet és kis/nagybetű nélkül is egyezik
  const compact = (x: string) =>
    x
      .toLowerCase()
      .normalize('NFD')
      .replace(/[^a-z0-9]/g, '');
  const pc = compact(project);
  const same = (a: string) => namesMatch(project, a) || (pc.length >= 3 && compact(a) === pc);
  const hit = incomeLeaves.find((l) => same(l.label) || (aliases.get(l.id) || []).some(same));
  return hit?.id ?? null;
}

export interface ProjectMonth {
  project: string;
  /** a munkaidő-táblák projektnevei, amelyek ehhez a partnerhez tartoznak (pl. „Kalmia” → Pharmazone) */
  names: string[];
  leaf: string | null;
  minutes: number;
  laborCost: number;
  /** alvállalkozói díj, amelynek tétele ezt az ügyfelet nevezi meg (pl. „Naturtex – marketing feladatok”) */
  subcontract: number;
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
  subcontract: number; // alvállalkozók díja (változó költség – projektenként jön)
  subcontractUnassigned: number; // ebből egyik ügyfélhez sem köthető (a tétel neve nem nevez meg ügyfelet)
  contribution: number; // fedezet = bevétel − változó költség (közvetlen munkaköltség + alvállalkozók)
  ratio: number; // fedezeti hányad
  fixed: number; // fix költség = összes kiadás − változó költség
  breakeven: number | null; // fedezeti pont (bevétel)
  margin: number | null; // biztonsági sáv = bevétel − fedezeti pont
  revenuePerBillableHour: number | null;
  projects: ProjectMonth[];
  people: { key: string; name: string; minutes: number; billableMinutes: number; cost: number; hourly: number | null }[];
}

/** Alvállalkozói (változó költségű) kiadási alkategóriák: az „Alvállalkozók” mappa sorai, a munkaidő-táblás munkatársak
 *  költség-kategóriája nélkül (az már a munkaköltségben van). */
function subcontractLeaves(leaves: Leaf[], groups: Group[], employees: Employee[]): Set<string> {
  const sectionOf = new Map(leaves.map((l) => [l.id, groups.find((g) => g.id === l.group_id)?.section]));
  const empLeaves = new Set(employees.map((e) => e.cost_leaf_id).filter(Boolean));
  return new Set(
    leaves
      .filter((l) => sectionOf.get(l.id) === 'out' && !empLeaves.has(l.id))
      .filter((l) => {
        const g = groups.find((x) => x.id === l.group_id)?.label || '';
        return g
          .toLowerCase()
          .normalize('NFD')
          .replace(/[\u0300-\u036f]/g, '')
          .includes('alvallalkoz');
      })
      .map((l) => l.id),
  );
}

/** Tény → a hozzá kötött terv neve: a banki tény neve a kedvezményezett (pl. „KOVÁCS BENCE EV”), a projektet a terv nevezi meg. */
function linkedPlanNames(entries: Entry[]): Map<string, string> {
  const planName = new Map<string, string>();
  for (const e of entries) if (e.kind === 'plan' && e.link_id && e.name) planName.set(e.link_id, e.name);
  const byId = new Map(entries.map((e) => [e.id, e]));
  for (const e of entries) {
    const p = e.kind === 'actual' && e.link_id ? byId.get(e.link_id) : undefined;
    if (p?.kind === 'plan' && p.name && !planName.has(e.id)) planName.set(e.id, p.name);
  }
  return planName;
}

/**
 * Fedezeti pont hónaponként: a munkatársak költsége (a cashflow-ban a hozzájuk rendelt kiadási alkategória tényei)
 * a ledolgozott idő arányában oszlik meg a projektek között. Változó költség: az ügyfélprojektre jutó munkaköltség és az
 * alvállalkozók díja (az „Alvállalkozók” mappa tényei); minden más kiadás fix. Fedezeti pont = fix költség / fedezeti hányad.
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
  // alvállalkozói kiadások (változó költség) – a munkaidő-táblás munkatársak költség-kategóriája nélkül (az már a munkaköltségben van)
  const subLeaves = subcontractLeaves(o.leaves, o.groups, o.employees);
  const leafCache = new Map<string, string | null>();
  const leafOf = (p: string) => {
    if (!leafCache.has(p)) leafCache.set(p, projectLeaf(p, incomeLeaves, o.aliases));
    return leafCache.get(p)!;
  };
  const planName = linkedPlanNames(o.entries);
  return o.months.map((ym) => {
    const acts = o.entries.filter((e) => e.kind === 'actual' && e.date.startsWith(ym));
    const revenue = acts.filter((e) => sectionOf.get(e.leaf_id) === 'in').reduce((a, e) => a + e.amount, 0);
    const expenses = -acts.filter((e) => sectionOf.get(e.leaf_id) === 'out').reduce((a, e) => a + e.amount, 0);
    // a régebben importált összesítő sor („Munkaidő összesen”) kimarad
    const wt = o.worktime.filter((w) => w.ym === ym && !/(^|\s)(összesen|osszesen|total)\b/i.test(w.project));
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
      // a költség megosztása: az elszámolás euró-összege (Feladatok „Összeg (EUR)” oszlop) arányában; ha nincs, az idő arányában
      const eurTotal = rows.reduce((a, w) => a + (w.eur || 0), 0);
      const share = (w: WorktimeRow) => (eurTotal > 0 ? ((w.eur || 0) / eurTotal) * cost : mins ? (w.minutes / mins) * cost : 0);
      let bill = 0;
      for (const w of rows) {
        const leaf = leafOf(w.project);
        // egy partner = egy sor: a partnerhez (név vagy alternatív név szerint) tartozó projektek összevonva – akkor is, ha a
        // partner több mappában szerepel (pl. Ajánlatok és Projektek alatt is „Orvosmost”)
        const pk = leaf ? 'p:' + partnerIdOf(o.leaves.find((l) => l.id === leaf)?.label || leaf) : w.project;
        const p = projects.get(pk) || {
          project: leaf ? o.leaves.find((l) => l.id === leaf)?.label || w.project : w.project,
          names: [],
          leaf,
          minutes: 0,
          laborCost: 0,
          subcontract: 0,
          revenue: 0,
        };
        if (!p.names.includes(w.project)) p.names.push(w.project);
        p.minutes += w.minutes;
        p.laborCost += share(w);
        projects.set(pk, p);
        if (leaf) {
          bill += w.minutes;
          directLabor += share(w);
        }
      }
      laborTotal += cost;
      minutes += mins;
      billableMinutes += bill;
      people.push({ key: emp.key, name: emp.name, minutes: mins, billableMinutes: bill, cost, hourly: mins ? (cost / mins) * 60 : null });
    }
    // projektbevétel: a projekthez párosított partner bevételi tényei a hónapban (egy partnerhez több projekt is tartozhat)
    // partnerenként (a partner minden bevételi alkategóriája együtt)
    const labelOf = (id: string) => o.leaves.find((l) => l.id === id)?.label || id;
    const keyOfLeaf = (id: string) => 'p:' + partnerIdOf(labelOf(id));
    const leafRevenue = new Map<string, { rev: number; leaf: string }>();
    for (const e of acts)
      if (sectionOf.get(e.leaf_id) === 'in') {
        const k = keyOfLeaf(e.leaf_id);
        const x = leafRevenue.get(k) || { rev: 0, leaf: e.leaf_id };
        x.rev += e.amount;
        leafRevenue.set(k, x);
      }
    for (const [k, p] of projects) if (p.leaf) p.revenue = leafRevenue.get(k)?.rev || 0;
    // bevételes partner, akin ebben a hónapban senki nem dolgozott (a felvitt munkatársak közül)
    for (const [k, x] of leafRevenue)
      if (!projects.has(k)) projects.set(k, { project: labelOf(x.leaf), names: [], leaf: x.leaf, minutes: 0, laborCost: 0, subcontract: 0, revenue: x.rev });
    // alvállalkozói díj → projekt: ha a tétel neve megnevezi az ügyfelet (név vagy alternatív név, pl. „Naturtex – marketing
    // feladatok”), a díj annak a projektnek a fedezetét csökkenti; ami egyik ügyfélhez sem köthető, külön összegként látszik
    let subUnassigned = 0;
    for (const e of acts) {
      if (!subLeaves.has(e.leaf_id)) continue;
      const leaf = leafOf(e.name || '') || (planName.has(e.id) ? leafOf(planName.get(e.id)!) : null);
      if (!leaf) {
        subUnassigned -= e.amount;
        continue;
      }
      const k = keyOfLeaf(leaf);
      const p = projects.get(k) || { project: labelOf(leaf), names: [], leaf, minutes: 0, laborCost: 0, revenue: 0, subcontract: 0 };
      p.subcontract -= e.amount;
      projects.set(k, p);
    }
    const subcontract = -acts.filter((e) => subLeaves.has(e.leaf_id)).reduce((a, e) => a + e.amount, 0);
    const variable = directLabor + subcontract;
    const contribution = revenue - variable;
    const ratio = revenue > 0 ? contribution / revenue : 0;
    const fixed = expenses - variable;
    const be = ratio > 0 ? fixed / ratio : null;
    return {
      ym,
      revenue,
      expenses,
      laborTotal,
      minutes,
      billableMinutes,
      directLabor: Math.round(directLabor),
      subcontract: Math.round(subcontract) || 0,
      subcontractUnassigned: Math.round(subUnassigned) || 0,
      contribution: Math.round(contribution),
      ratio,
      fixed: Math.round(fixed),
      breakeven: be == null ? null : Math.round(be),
      margin: be == null ? null : Math.round(revenue - be),
      revenuePerBillableHour: billableMinutes ? Math.round(revenue / (billableMinutes / 60)) : null,
      projects: [...projects.values()]
        .map((p) => ({ ...p, laborCost: Math.round(p.laborCost), subcontract: Math.round(p.subcontract) || 0 }))
        .sort((a, b) => b.revenue - a.revenue || b.minutes - a.minutes),
      people,
    };
  });
}

/** Az ügyfél nevét viselő alvállalkozói díjak egy partnernél (a partner adatlapjához). */
export interface PartnerSubcontract {
  /** tény az utolsó 12 hónapban (pozitív) */
  last12: number;
  /** összes tény (pozitív) */
  total: number;
  count: number;
  /** nyitott tervek (várható díj, pozitív) */
  planned: number;
  /** a tények, legfrissebb elöl */
  items: Entry[];
}

/**
 * Alvállalkozói díjak partnerenként (kulcs: partnerIdOf): ha a tétel (vagy a hozzá kötött terv) neve megnevezi az ügyfelet –
 * ugyanaz a hozzárendelés, mint a Fedezeti pont projekt-soraiban. Csak megjelenítéshez: a partner Kiadás / Nettó értéke
 * nem változik, a díj továbbra is az alvállalkozó sorában van.
 */
export function partnerSubcontracts(o: {
  entries: Entry[];
  leaves: Leaf[];
  groups: Group[];
  employees: Employee[];
  partners: { key: string; name: string; aliases?: string[] | null }[];
  today: string;
}): Map<string, PartnerSubcontract> {
  const sectionOf = new Map(o.leaves.map((l) => [l.id, o.groups.find((g) => g.id === l.group_id)?.section]));
  const incomeLeaves = o.leaves.filter((l) => sectionOf.get(l.id) === 'in');
  const subLeaves = subcontractLeaves(o.leaves, o.groups, o.employees);
  // a partnertörzs neve és alternatív nevei is megnevezhetik az ügyfelet (mint a Fedezeti pontban)
  const aliases = new Map<string, string[]>();
  for (const l of o.leaves) {
    const p = o.partners.find((x) => x.key === partnerIdOf(l.label));
    if (p) aliases.set(l.id, [p.name, ...(p.aliases || [])]);
  }
  const planName = linkedPlanNames(o.entries);
  const labelOf = new Map(o.leaves.map((l) => [l.id, l.label]));
  const cache = new Map<string, string | null>();
  const leafOf = (name: string) => {
    if (!cache.has(name)) cache.set(name, name ? projectLeaf(name, incomeLeaves, aliases) : null);
    return cache.get(name)!;
  };
  const cur = o.today.slice(0, 7);
  const [y, m] = cur.split('-').map(Number);
  const from = `${m === 12 ? y : y - 1}-${String((m % 12) + 1).padStart(2, '0')}`; // 12 hónap a mostanival együtt
  const out = new Map<string, PartnerSubcontract>();
  for (const e of o.entries) {
    if (!subLeaves.has(e.leaf_id) || (e.kind === 'plan' && e.done) || (e.kind !== 'plan' && e.kind !== 'actual')) continue;
    const leaf = leafOf(e.name || '') || (planName.has(e.id) ? leafOf(planName.get(e.id)!) : null);
    if (!leaf) continue;
    const key = partnerIdOf(labelOf.get(leaf) || '') || leaf;
    const s = out.get(key) || { last12: 0, total: 0, count: 0, planned: 0, items: [] };
    if (e.kind === 'plan') s.planned -= e.amount;
    else {
      s.total -= e.amount;
      s.count++;
      if (e.date.slice(0, 7) >= from && e.date.slice(0, 7) <= cur) s.last12 -= e.amount;
      s.items.push(e);
    }
    out.set(key, s);
  }
  for (const s of out.values()) s.items.sort((a, b) => b.date.localeCompare(a.date));
  return out;
}
