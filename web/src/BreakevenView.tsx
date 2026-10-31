// Fedezeti pont: munkatársanként feltöltött havi munkaidő (Clockify-szerű XLS) + a cashflow tényei →
// munkaköltség projektenként, projektfedezet, a cég havi fedezeti pontja; letölthető XLS.
import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { MS, addMonths, fmt, monthDiff, monthLabel, monthLong, monthRange } from '../../shared/model';
import { namesMatch } from '../../shared/billingopay';
import { partnerIdOf } from '../../shared/partners';
import { breakeven, parseWorkSheets, sheetIdOf, type BreakevenMonth, type Employee, type ProjectMonth } from '../../shared/worktime';

const MONTH_HU = ['január', 'február', 'március', 'április', 'május', 'június', 'július', 'augusztus', 'szeptember', 'október', 'november', 'december'];
import { api } from './api';
import { rowsOfSheet } from './sheetCore';
import { useStore } from './store';
import { C, FONT, FONT_H, LeafSelect, Pill, card, eyebrow, inputStyle, R } from './ui';

const h = (min: number) => (min / 60).toLocaleString('hu-HU', { maximumFractionDigits: 1 });
const pct = (r: number) => (r * 100).toLocaleString('hu-HU', { maximumFractionDigits: 1 }) + '%';

/** A munkatárs Drive-on (Google-táblázat) lévő munkaidő-táblájának letöltése és beolvasása. */
export async function refreshFromDrive(
  emp: Employee,
  run: (fn: () => Promise<unknown>, msg?: string) => Promise<boolean>,
  showToast: (t: { msg: string; error?: boolean }) => void,
) {
  try {
    const r = await api<{ xlsx: string }>('/api/worktime/fetch', { body: { employee: emp.key } });
    const bin = atob(r.xlsx);
    const buf = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
    return await importWorkbook(emp, buf.buffer, run, showToast);
  } catch (e: any) {
    showToast({ msg: e.message || `${emp.name}: nem sikerült betölteni a táblát.`, error: true });
    return false;
  }
}

/** Munkaidő-munkafüzet (feltöltött fájl vagy a linkről letöltött tábla) beolvasása és mentése a munkatárshoz. */
export async function importWorkbook(
  emp: Employee,
  buf: ArrayBuffer,
  run: (fn: () => Promise<unknown>, msg?: string) => Promise<boolean>,
  showToast: (t: { msg: string; error?: boolean }) => void,
) {
  try {
    const XLSX = await import('xlsx');
    const wb = XLSX.read(buf, { type: 'array', raw: true, cellDates: false, cellFormula: false, cellStyles: false });
    const sheets: Record<string, unknown[][]> = {};
    for (const n of wb.SheetNames) if (/-Feladatok$/i.test(n)) sheets[n] = rowsOfSheet(XLSX, wb.Sheets[n]);
    const rows = parseWorkSheets(sheets);
    if (!rows.length) throw new Error('Nem találtam „ÉÉÉÉ.HH-Feladatok” lapot (Tag · Projekt · Idő oszlopokkal).');
    const nMonths = new Set(rows.map((r) => r.ym)).size;
    return await run(
      () => api('/api/worktime/import', { body: { employee: emp.key, rows } }),
      `${emp.name}: ${nMonths} hónap munkaideje betöltve (${h(rows.reduce((a, r) => a + r.minutes, 0))} óra)`,
    );
  } catch (e: any) {
    showToast({ msg: e.message || 'Nem sikerült beolvasni a fájlt.', error: true });
    return false;
  }
}

// színek: zöld = pozitív biztonsági sáv / jó óradíj, a kiválasztott hónap oszlopa halványkék
const GREEN = C.inc;
const GREEN_BG = '#E7F3EC';
const GREEN_BAR = '#A3CFB3';
const RED_BAR = '#E5A598';
const SEL_BG = '#EAF3FA';
const MONTH_IN = [
  'januárban',
  'februárban',
  'márciusban',
  'áprilisban',
  'májusban',
  'júniusban',
  'júliusban',
  'augusztusban',
  'szeptemberben',
  'októberben',
  'novemberben',
  'decemberben',
];

const m2 = (n: number) => (n / 1e6).toLocaleString('hu-HU', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const sgn = (n: number) => (n > 0 ? '+' : n < 0 ? '−' : '');
const sm2 = (n: number) => sgn(n) + m2(Math.abs(n));
const sfmt = (n: number) => sgn(n) + fmt(Math.abs(n));
const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** KPI-csempe az „X röviden” kártyán. */
function Kpi(p: { label: string; value: string; sub: ReactNode; tone?: 'pos' | 'neg' }) {
  return (
    <div
      style={{
        background: p.tone === 'pos' ? GREEN_BG : p.tone === 'neg' ? C.negBg : C.bg,
        borderRadius: R.lg,
        padding: '12px 14px',
        display: 'flex',
        flexDirection: 'column',
        gap: 4,
        minWidth: 0,
      }}
    >
      <span style={{ ...eyebrow, fontSize: 10.5 }}>{p.label}</span>
      <span
        style={{
          font: `800 clamp(20px,1.8vw,26px)/1.1 ${FONT_H}`,
          color: p.tone === 'pos' ? GREEN : p.tone === 'neg' ? C.neg : C.navy,
          fontVariantNumeric: 'tabular-nums',
          whiteSpace: 'nowrap',
        }}
      >
        {p.value}
      </span>
      <span style={{ font: `500 12px ${FONT}`, color: C.muted }}>{p.sub}</span>
    </div>
  );
}

/** Eltérés az átlagtól: kék = jó irány, piros = rossz irány. */
const Delta = (p: { d: number; text: string; good: boolean }) => (
  <span style={{ color: p.good ? C.inc : C.neg, fontWeight: 600 }}>
    {p.d >= 0 ? '▲' : '▼'} {p.text}
  </span>
);

const stepBtn = (disabled?: boolean): CSSProperties => ({
  border: 0,
  background: 'transparent',
  borderRadius: 999,
  padding: '6px 10px',
  cursor: disabled ? 'default' : 'pointer',
  font: `600 13px ${FONT}`,
  color: disabled ? C.line2 : C.navy,
});

export function BreakevenView() {
  const { ix, data, run, isAdmin, showToast, openPartner } = useStore();
  const employees = data.employees || [];
  const worktime = data.worktime || [];
  // régi import (euró-oszlop és összesítő-szűrés előtt): a táblát egyszer magától újratölti a Drive-linkről
  useEffect(() => {
    if (!isAdmin) return;
    for (const emp of employees) {
      const rows = worktime.filter((w) => w.employee === emp.key);
      const stale = rows.length > 0 && rows.every((w) => !w.eur);
      const mark = 'cf_wt_refresh_' + emp.key;
      if (!emp.sheet_url || !stale) continue;
      try {
        if (sessionStorage.getItem(mark)) continue;
        sessionStorage.setItem(mark, '1');
      } catch {}
      refreshFromDrive(emp, run, showToast);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  // 12 hónapos ablak; a kiválasztott hónap a léptetővel vagy az oszlopfejre kattintva változik
  const [endYm, setEndYm] = useState(ix.cur);
  const months = useMemo(() => monthRange(addMonths(endYm, -11), endYm), [endYm]);
  const aliases = useMemo(() => {
    const m = new Map<string, string[]>();
    for (const l of ix.leaves) {
      const p = (data.partners || []).find((x) => x.key === partnerIdOf(l.label));
      if (p) m.set(l.id, [p.name, ...(p.aliases || [])]);
    }
    return m;
  }, [ix.leaves, data.partners]);
  const report = useMemo(
    () => breakeven({ months, entries: data.entries, leaves: ix.leaves, groups: ix.groups, employees, worktime, aliases }),
    [months, data.entries, ix.leaves, ix.groups, employees, worktime, aliases],
  );
  const [selS, setSel] = useState(() => [...months].reverse().find((m) => worktime.some((w) => w.ym === m)) || ix.cur);
  const sel = months.includes(selS) ? selS : months[months.length - 1];
  const cur = report.find((r) => r.ym === sel);
  // léptetés: ha a cél kívül esik az ablakon, az ablak úgy tolódik, hogy az legyen az utolsó oszlop
  const go = (ym: string) => {
    const t = ym > ix.cur ? ix.cur : ym;
    setSel(t);
    if (!months.includes(t)) setEndYm(t);
  };
  const ago = monthDiff(ix.cur, sel);
  // összevetés: a kiválasztott hónap és az előtte lévő 12 hónap (csak az adatos hónapok számítanak)
  const kpiRep = useMemo(
    () =>
      breakeven({
        months: monthRange(addMonths(sel, -12), sel),
        entries: data.entries,
        leaves: ix.leaves,
        groups: ix.groups,
        employees,
        worktime,
        aliases,
      }),
    [sel, data.entries, ix.leaves, ix.groups, employees, worktime, aliases],
  );
  const hasData = (r: BreakevenMonth) => !!(r.revenue || r.expenses);
  const prev = kpiRep.slice(0, 12).filter(hasData);
  const last12 = kpiRep.slice(1).filter(hasData);
  const negMonths = last12.filter((r) => (r.margin ?? 0) < 0).length;
  const revAvg = avg(prev.map((r) => r.revenue));
  const beAvg = avg(prev.filter((r) => r.breakeven != null).map((r) => r.breakeven!));
  const utilAvg = avg(prev.filter((r) => r.minutes).map((r) => r.billableMinutes / r.minutes));
  const rphAvg = avg(prev.filter((r) => r.revenuePerBillableHour).map((r) => r.revenuePerBillableHour!));

  const [newName, setNewName] = useState('');
  const [showNoInv, setShowNoInv] = useState(false);
  const [showHow, setShowHow] = useState(false);
  const [srcOpen, setSrcOpen] = useState(true);
  const srcRef = useRef<HTMLDivElement>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [urls, setUrls] = useState<Record<string, string>>({});
  const refresh = async (list: Employee[]) => {
    for (const emp of list) {
      setBusy(emp.key);
      await refreshFromDrive(emp, run, showToast);
    }
    setBusy(null);
  };
  const withSheet = employees.filter((e) => e.sheet_url);
  const noWork = employees.filter((e) => !worktime.some((w) => w.employee === e.key));
  // a hónapban számlázott / fizető ügyfelek: bevételi tény, vagy a hónapban kiállított Billingo-számla
  const leafAliases = (leaf: string) => [ix.leafById[leaf]?.label || '', ...(aliases.get(leaf) || [])].filter(Boolean);
  const invoicedLeaves = useMemo(() => {
    const out = new Set<string>();
    if (!cur) return out;
    for (const p of cur.projects) {
      if (!p.leaf) continue;
      if (p.revenue) {
        out.add(p.leaf);
        continue;
      }
      const names = leafAliases(p.leaf);
      const hit = data.billingo.some(
        (d) =>
          !d.cancelled &&
          (d.invoice_date || '').startsWith(cur.ym) &&
          ((d.plan_id && data.entries.find((e) => e.id === d.plan_id)?.leaf_id === p.leaf) || (!!d.partner && names.some((n) => namesMatch(n, d.partner!)))),
      );
      if (hit) out.add(p.leaf);
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cur, data.billingo, data.entries, aliases]);
  const invoiced = cur ? cur.projects.filter((p) => p.leaf && invoicedLeaves.has(p.leaf)) : [];
  const noInv = cur ? cur.projects.filter((p) => !(p.leaf && invoicedLeaves.has(p.leaf))) : [];
  const noInvMin = noInv.reduce((a, p) => a + p.minutes, 0);

  const outLeaves = ix.leaves.filter((l) => !l.archived && ix.sectionOf(l.id) === 'out');
  const guessLeaf = (name: string) =>
    outLeaves.find((l) => namesMatch(name, l.label) || l.label.toLowerCase().includes(name.toLowerCase().split(' ')[0]))?.id || null;
  const saveEmp = (e: { key?: string; name: string; cost_leaf_id: string | null }, msg: string) =>
    run(() => api('/api/employees', { method: 'PUT', body: e }), msg);

  const upload = async (emp: Employee, file: File) => importWorkbook(emp, await file.arrayBuffer(), run, showToast);

  const download = async () => {
    const XLSX = await import('xlsx');
    const wb = XLSX.utils.book_new();
    const rows: (string | number | null)[][] = [
      ['Fedezeti pont – havi összesítő', ...report.map((r) => monthLong(r.ym))],
      ['Bevétel (tény)', ...report.map((r) => r.revenue)],
      ['Összes kiadás (tény)', ...report.map((r) => r.expenses)],
      ['Munkatársak költsége', ...report.map((r) => r.laborTotal)],
      ['Közvetlen munkaköltség (ügyfélprojektek)', ...report.map((r) => r.directLabor)],
      ['Alvállalkozók', ...report.map((r) => r.subcontract)],
      ['Fedezet (bevétel − változó költség)', ...report.map((r) => r.contribution)],
      ['Fedezeti hányad', ...report.map((r) => (r.revenue ? Math.round(r.ratio * 1000) / 10 : null))],
      ['Fix költség (kiadás − változó költség)', ...report.map((r) => r.fixed)],
      ['Fedezeti pont (fix / hányad)', ...report.map((r) => r.breakeven)],
      ['Biztonsági sáv (bevétel − fedezeti pont)', ...report.map((r) => r.margin)],
      ['Ledolgozott óra', ...report.map((r) => Math.round(r.minutes / 6) / 10)],
      ['Ügyfélprojekten (óra)', ...report.map((r) => Math.round(r.billableMinutes / 6) / 10)],
      ['Kihasználtság (%)', ...report.map((r) => (r.minutes ? Math.round((r.billableMinutes / r.minutes) * 1000) / 10 : null))],
      ['Bevétel / ügyfélóra', ...report.map((r) => r.revenuePerBillableHour)],
    ];
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows), 'Fedezeti pont');
    const proj: (string | number)[][] = [['Hónap', 'Projekt', 'Partner (cashflow)', 'Óra', 'Munkaköltség', 'Bevétel', 'Fedezet']];
    for (const r of report)
      for (const p of r.projects)
        proj.push([
          r.ym,
          p.project,
          p.leaf ? ix.leafById[p.leaf]?.label || '' : 'belső',
          Math.round(p.minutes / 6) / 10,
          p.laborCost,
          p.revenue,
          p.revenue - p.laborCost,
        ]);
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(proj), 'Projektek');
    for (const emp of employees) {
      const own = worktime.filter((w) => w.employee === emp.key && months.includes(w.ym));
      const projects = [...new Set(own.map((w) => w.project))].sort((a, b) => a.localeCompare(b, 'hu'));
      const sheet: (string | number | null)[][] = [
        [emp.name, ...months.map(monthLong)],
        ['Költség (cashflow)', ...months.map((m) => report.find((r) => r.ym === m)?.people.find((p) => p.key === emp.key)?.cost ?? null)],
        [
          'Óraköltség',
          ...months.map((m) => {
            const p = report.find((r) => r.ym === m)?.people.find((x) => x.key === emp.key);
            return p?.hourly ? Math.round(p.hourly) : null;
          }),
        ],
        ['Ledolgozott óra', ...months.map((m) => Math.round(own.filter((w) => w.ym === m).reduce((a, w) => a + w.minutes, 0) / 6) / 10)],
        [],
        ['Projekt (óra)'],
        ...projects.map((p) => [
          p,
          ...months.map((m) => Math.round(own.filter((w) => w.ym === m && w.project === p).reduce((a, w) => a + w.minutes, 0) / 6) / 10 || null),
        ]),
      ];
      XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(sheet), emp.name.replace(/[\\/?*[\]:]/g, ' ').slice(0, 31));
    }
    XLSX.writeFile(wb, `fedezeti-pont-${ix.cur}.xlsx`);
  };

  // táblázat-cellák
  const th: CSSProperties = { ...eyebrow, fontSize: 10.5, padding: '9px 10px', textAlign: 'right', borderBottom: `1px solid ${C.line}`, whiteSpace: 'nowrap' };
  const td: CSSProperties = {
    padding: '7px 7px',
    font: `500 12.5px ${FONT}`,
    color: C.ink,
    textAlign: 'right',
    borderTop: `1px solid ${C.line3}`,
    fontVariantNumeric: 'tabular-nums',
    whiteSpace: 'nowrap',
  };
  const maxMargin = Math.max(1, ...report.map((r) => Math.abs(r.margin ?? 0)));
  type Line = { label: string; v: (r: BreakevenMonth) => ReactNode; hint?: string; bold?: boolean; color?: (r: BreakevenMonth) => string | undefined };
  const sections: [string, Line[]][] = [
    [
      'Eredmény',
      [
        { label: 'Bevétel', v: (r) => fmt(r.revenue), bold: true },
        { label: 'Összes kiadás', v: (r) => fmt(r.expenses) },
        {
          label: 'Fedezet',
          v: (r) => fmt(r.contribution),
          hint: 'bevétel − változó költség (közvetlen bér + alvállalkozók)',
          color: (r) => (r.contribution < 0 ? C.neg : undefined),
        },
        { label: 'Fedezeti hányad', v: (r) => (r.revenue ? pct(r.ratio) : '–'), hint: 'fedezet / bevétel' },
      ],
    ],
    [
      'Költség',
      [
        { label: 'Közvetlen munkaköltség', v: (r) => fmt(r.directLabor), hint: 'ügyfélprojektekre jutó bér (az idő arányában)' },
        { label: 'Alvállalkozók', v: (r) => fmt(r.subcontract), hint: 'az „Alvállalkozók” mappa kiadásai – változó költség, mint a közvetlen bér' },
        { label: 'Fix költség', v: (r) => fmt(r.fixed), hint: 'minden más kiadás (iroda, szoftver, belső munkaidő …)' },
        { label: 'Fedezeti pont', v: (r) => (r.breakeven == null ? '–' : fmt(r.breakeven)), hint: 'ennyi bevétel kell, hogy ne legyen veszteség', bold: true },
      ],
    ],
    [
      'Kockázat',
      [
        {
          label: 'Biztonsági sáv',
          hint: 'bevétel − fedezeti pont',
          v: (r) =>
            r.margin == null ? (
              '–'
            ) : (
              <span style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 4, width: '100%' }}>
                <span
                  style={{
                    width: `${Math.max(6, (Math.abs(r.margin) / maxMargin) * 100)}%`,
                    height: r.ym === sel ? 14 : 7,
                    borderRadius: R.sm,
                    background: r.margin >= 0 ? GREEN_BAR : RED_BAR,
                  }}
                />
                {sfmt(r.margin)}
              </span>
            ),
          color: (r) => (r.margin == null ? undefined : r.margin < 0 ? C.neg : GREEN),
        },
      ],
    ],
    [
      'Kapacitás',
      [
        { label: 'Ledolgozott óra', v: (r) => (r.minutes ? h(r.minutes) : '–') },
        { label: 'Kihasználtság', v: (r) => (r.minutes ? pct(r.billableMinutes / r.minutes) : '–'), hint: 'ügyfélprojekten töltött idő aránya' },
        {
          label: 'Bevétel / ügyfélóra',
          v: (r) => (r.revenuePerBillableHour ? fmt(r.revenuePerBillableHour) : '–'),
          hint: 'bevétel / ügyfélprojekten töltött óra',
        },
      ],
    ],
  ];
  const selBg = (ym: string) => (ym === sel ? SEL_BG : undefined);

  // bevételi ügyfelek (partnerenként egyszer) a belső projekt hozzárendeléséhez
  const clients = useMemo(() => {
    const m = new Map<string, string>();
    for (const l of ix.leaves) if (!l.archived && ix.sectionOf(l.id) === 'in' && !m.has(partnerIdOf(l.label))) m.set(partnerIdOf(l.label), l.label);
    return [...m.entries()].sort((a, b) => a[1].localeCompare(b[1], 'hu'));
  }, [ix]);
  const attach = (project: string, key: string) => {
    const cur = (data.partners || []).find((x) => x.key === key)?.aliases || [];
    const label = clients.find(([k]) => k === key)?.[1] || key;
    return run(
      () => api(`/api/partners/${encodeURIComponent(key)}`, { method: 'PUT', body: { aliases: [...cur, project] } }),
      `${project} → ${label}: összevonva`,
      () => api(`/api/partners/${encodeURIComponent(key)}`, { method: 'PUT', body: { aliases: cur } }),
    );
  };

  const projRow = (p: ProjectMonth, muted?: boolean) => {
    const contrib = p.revenue - p.laborCost;
    return (
      <div key={(p.leaf || '') + p.project} style={{ display: 'contents' }}>
        <div style={{ ...td, textAlign: 'left', whiteSpace: 'normal', background: muted ? C.bg3 : undefined }}>
          {p.leaf ? (
            <button
              onClick={() => openPartner(p.leaf!)}
              title="Ügyfél adatlapja"
              style={{ border: 0, background: 'transparent', padding: 0, cursor: 'pointer', font: `700 13px ${FONT}`, color: C.blueDark, textAlign: 'left' }}
            >
              {p.project} ›
            </button>
          ) : (
            <b style={{ color: C.navy }}>{p.project}</b>
          )}
          <span style={{ color: C.muted, fontSize: 11.5 }}>
            {p.leaf
              ? p.names.filter((n) => n !== p.project).length
                ? ` munkaidőben: ${p.names.filter((n) => n !== p.project).join(', ')}`
                : ''
              : ' · belső / nincs párosítva'}
          </span>
          {/* belső / párosítatlan projekt → ügyfélhez rendelés: a név az ügyfél alternatív neve lesz, a munkaidő onnantól ott számít */}
          {!p.leaf && isAdmin && (
            <select
              value=""
              onChange={(ev) => ev.target.value && attach(p.project, ev.target.value)}
              title="A projekt ehhez az ügyfélhez tartozik (alternatív név lesz az adatlapján)"
              style={{
                marginLeft: 8,
                height: 26,
                maxWidth: 170,
                borderRadius: R.md,
                border: `1px solid ${C.line2}`,
                font: `500 12px ${FONT}`,
                color: C.blueDark,
              }}
            >
              <option value="">Ügyfélhez rendel…</option>
              {clients.map(([k, label]) => (
                <option key={k} value={k}>
                  {label}
                </option>
              ))}
            </select>
          )}
        </div>
        <div style={{ ...td, color: C.muted }}>{p.minutes ? h(p.minutes) : '–'}</div>
        <div style={{ ...td, color: C.muted }}>{p.laborCost ? fmt(p.laborCost) : '–'}</div>
        <div style={{ ...td, fontWeight: 700, color: C.navy }}>{p.revenue ? fmt(p.revenue) : '–'}</div>
        <div style={{ ...td, fontWeight: 700, color: p.leaf ? (contrib < 0 ? C.neg : C.inc) : C.muted }}>{p.leaf ? fmt(contrib) : '–'}</div>
        <div style={{ ...td, fontWeight: 700, color: contrib < 0 ? C.neg : GREEN }}>{p.leaf && p.minutes ? fmt(contrib / (p.minutes / 60)) : '–'}</div>
      </div>
    );
  };

  const util = cur && cur.minutes ? cur.billableMinutes / cur.minutes : null;
  const monName = MONTH_HU[Number(sel.slice(5, 7)) - 1];

  return (
    <div style={{ padding: '28px 32px 120px', display: 'flex', flexDirection: 'column', gap: 18 }}>
      {/* fejléc: cím, hónap-léptető, XLS */}
      <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', gap: 16, flexWrap: 'wrap' }}>
        <div>
          <div style={{ ...eyebrow, color: C.blue, marginBottom: 8 }}>Munkaidő · költség · bevétel</div>
          <h1 style={{ margin: 0, font: `700 30px/1.05 ${FONT_H}`, color: C.navy }}>Fedezeti pont</h1>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 2, background: '#fff', border: `1px solid ${C.line}`, borderRadius: 999, padding: 3 }}>
            <button type="button" style={stepBtn()} onClick={() => go(addMonths(sel, -12))} title="12 hónappal vissza">
              ‹ 12 hó
            </button>
            <button type="button" style={stepBtn()} onClick={() => go(addMonths(sel, -1))} title="Előző hónap">
              ‹
            </button>
            <button
              type="button"
              onClick={() => sel !== ix.cur && go(ix.cur)}
              title={sel !== ix.cur ? 'Vissza az aktuális hónapra' : undefined}
              style={{
                ...stepBtn(sel === ix.cur),
                minWidth: 130,
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                lineHeight: 1.2,
                padding: '3px 10px',
              }}
            >
              <b style={{ font: `700 13.5px ${FONT_H}`, color: C.navy }}>{monthLong(sel)}</b>
              <span style={{ font: `500 10.5px ${FONT}`, color: C.muted }}>{ago ? `${ago} hónapja · ugrás a mára` : 'aktuális hónap'}</span>
            </button>
            <button type="button" style={stepBtn(sel >= ix.cur)} disabled={sel >= ix.cur} onClick={() => go(addMonths(sel, 1))} title="Következő hónap">
              ›
            </button>
          </div>
          <Pill kind="dark" onClick={download}>
            XLS letöltés
          </Pill>
        </div>
      </div>

      {/* röviden: KPI-k az előző 12 hónap átlagához */}
      {cur && (
        <div style={{ ...card, padding: '16px 18px', display: 'flex', flexDirection: 'column', gap: 14 }}>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, flexWrap: 'wrap' }}>
            <b style={{ font: `700 15px ${FONT_H}`, color: C.navy }}>{cap(monName)} röviden</b>
            <span style={{ font: `500 12.5px ${FONT}`, color: C.muted }}>vs. előző 12 hónap átlaga</span>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(170px,1fr))', gap: 10 }}>
            <Kpi
              label="Bevétel"
              value={`${m2(cur.revenue)} M`}
              sub={
                revAvg == null ? (
                  'nincs korábbi adat'
                ) : (
                  <Delta d={cur.revenue - revAvg} text={`${sm2(cur.revenue - revAvg)} M az átlaghoz`} good={cur.revenue >= revAvg} />
                )
              }
            />
            <Kpi
              label="Fedezeti pont"
              value={cur.breakeven == null ? '–' : `${m2(cur.breakeven)} M`}
              sub={
                cur.breakeven == null || beAvg == null ? (
                  cur.breakeven == null ? (
                    'nincs fedezet'
                  ) : (
                    'nincs korábbi adat'
                  )
                ) : (
                  <Delta d={cur.breakeven - beAvg} text={`${sm2(cur.breakeven - beAvg)} M az átlaghoz`} good={cur.breakeven <= beAvg} />
                )
              }
            />
            <Kpi
              label="Biztonsági sáv"
              value={cur.margin == null ? '–' : `${sm2(cur.margin)} M`}
              tone={cur.margin == null ? undefined : cur.margin >= 0 ? 'pos' : 'neg'}
              sub={`${last12.length} hóból ${negMonths} negatív`}
            />
            <Kpi
              label="Kihasználtság"
              value={util == null ? '–' : `${Math.round(util * 100)}%`}
              sub={
                util == null ? (
                  'nincs feltöltött munkaidő'
                ) : utilAvg == null ? (
                  'nincs korábbi adat'
                ) : (
                  <Delta
                    d={util - utilAvg}
                    text={`átlag ${Math.round(utilAvg * 100)}% · ${sgn(Math.round((util - utilAvg) * 100))}${Math.abs(Math.round((util - utilAvg) * 100))} pp`}
                    good={util >= utilAvg}
                  />
                )
              }
            />
            <Kpi
              label="Bevétel / ügyfélóra"
              value={cur.revenuePerBillableHour ? fmt(cur.revenuePerBillableHour) : '–'}
              sub={
                !cur.revenuePerBillableHour || rphAvg == null ? (
                  'nincs összevetés'
                ) : (
                  <Delta
                    d={cur.revenuePerBillableHour - rphAvg}
                    text={`${sfmt(cur.revenuePerBillableHour - rphAvg)} az átlaghoz`}
                    good={cur.revenuePerBillableHour >= rphAvg}
                  />
                )
              }
            />
          </div>
          <div style={{ background: C.bg, borderRadius: R.lg, padding: '10px 14px', font: `400 13px/1.5 ${FONT}`, color: C.ink }}>
            {cap(MONTH_IN[Number(sel.slice(5, 7)) - 1])}{' '}
            {cur.margin == null ? (
              'a fedezeti pont nem számolható (nincs pozitív fedezet)'
            ) : cur.margin >= 0 ? (
              <>
                <b>a bevétel {m2(cur.margin)} M-val a fedezeti pont felett</b> volt
              </>
            ) : (
              <>
                <b style={{ color: C.neg }}>a bevétel {m2(-cur.margin)} M-val a fedezeti pont alatt</b> maradt
              </>
            )}{' '}
            — a {last12.length} hónapból <b>{negMonths}</b> negatív.{' '}
            {util == null ? (
              'Ebben a hónapban nincs feltöltött munkaidő.'
            ) : (
              <>
                A kihasználtság <b>{Math.round(util * 100)}%</b>
                {utilAvg != null && ` (átlag ${Math.round(utilAvg * 100)}%)`}
                {noInvMin > 0 ? `: ${Math.round(noInvMin / 60).toLocaleString('hu-HU')} óra számla nélküli munka.` : '.'}
              </>
            )}
          </div>
        </div>
      )}

      {/* havi összesítő */}
      <div style={{ ...card, overflow: 'hidden' }}>
        <div style={{ overflow: 'auto' }}>
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: `minmax(150px,1.2fr) repeat(${report.length}, minmax(70px,1fr))`,
              minWidth: 160 + report.length * 74,
            }}
          >
            <div
              style={{
                ...td,
                borderTop: 0,
                borderBottom: `1px solid ${C.line}`,
                textAlign: 'left',
                font: `700 15px ${FONT_H}`,
                color: C.navy,
                alignSelf: 'stretch',
                display: 'flex',
                alignItems: 'center',
              }}
            >
              Havi összesítő
            </div>
            {report.map((r) => {
              const on = r.ym === sel;
              return (
                <button
                  key={r.ym}
                  onClick={() => setSel(r.ym)}
                  title="Részletek: projektek és munkatársak"
                  style={{
                    border: 0,
                    borderBottom: `1px solid ${on ? C.navy : C.line}`,
                    cursor: 'pointer',
                    padding: '8px 10px',
                    background: on ? C.navy : '#fff',
                    display: 'flex',
                    flexDirection: 'column',
                    alignItems: 'flex-end',
                    gap: 1,
                    lineHeight: 1.2,
                  }}
                >
                  {r.ym === ix.cur && (
                    <span
                      style={{
                        font: `700 9px ${FONT}`,
                        letterSpacing: '.08em',
                        padding: '1px 6px',
                        borderRadius: 999,
                        background: on ? '#fff' : C.navy,
                        color: on ? C.navy : '#fff',
                      }}
                    >
                      MOST
                    </span>
                  )}
                  <span style={{ font: `500 10.5px ${FONT}`, color: on ? C.muted2 : C.muted }}>{r.ym.slice(0, 4)}</span>
                  <span style={{ font: `700 12.5px ${FONT}`, color: on ? '#fff' : C.navy }}>{MS[Number(r.ym.slice(5, 7)) - 1].toLowerCase()}</span>
                </button>
              );
            })}
            {sections.map(([title, lines]) => (
              <div key={title} style={{ display: 'contents' }}>
                <div style={{ ...eyebrow, fontSize: 10, color: C.blue, padding: '12px 10px 4px', borderTop: `1px solid ${C.line3}` }}>{title}</div>
                {report.map((r) => (
                  <div key={r.ym} style={{ borderTop: `1px solid ${C.line3}`, background: selBg(r.ym) }} />
                ))}
                {lines.map((l) => (
                  <div key={l.label} style={{ display: 'contents' }}>
                    <div style={{ ...td, textAlign: 'left', fontWeight: l.bold ? 700 : 500, color: C.navy }} title={l.hint}>
                      {l.label}
                    </div>
                    {report.map((r) => (
                      <div
                        key={r.ym}
                        style={{
                          ...td,
                          fontWeight: l.bold ? 700 : 500,
                          color: l.color?.(r) || (l.bold ? C.navy : C.ink),
                          background: selBg(r.ym),
                          alignSelf: 'stretch',
                          display: 'flex',
                          flexDirection: 'column',
                          justifyContent: 'flex-end',
                          alignItems: 'flex-end',
                        }}
                      >
                        {l.v(r)}
                      </div>
                    ))}
                  </div>
                ))}
              </div>
            ))}
          </div>
        </div>
        <div style={{ borderTop: `1px solid ${C.line}`, padding: '10px 14px', font: `400 12px/1.5 ${FONT}`, color: C.muted }}>
          <button
            type="button"
            onClick={() => setShowHow((x) => !x)}
            style={{ border: 0, background: 'transparent', padding: 0, cursor: 'pointer', font: `600 12px ${FONT}`, color: C.navy }}
          >
            {showHow ? '▾' : '›'} Hogyan számolunk?
          </button>{' '}
          — változó költség = ügyfélprojektre jutó bér (a munkatárs költsége a ledolgozott idő arányában) + alvállalkozók; minden más fix. Fedezet = bevétel −
          változó költség, fedezeti hányad = fedezet / bevétel, fedezeti pont = fix költség / fedezeti hányad.
          {showHow && (
            <ul style={{ margin: '8px 0 2px', paddingLeft: 18, display: 'flex', flexDirection: 'column', gap: 2 }}>
              {sections.flatMap(([, lines]) =>
                lines
                  .filter((l) => l.hint)
                  .map((l) => (
                    <li key={l.label}>
                      <b style={{ color: C.navy }}>{l.label}</b>: {l.hint}
                    </li>
                  )),
              )}
              <li>Az összehasonlító átlag az előző 12 hónapból számol, csak azokból a hónapokból, ahol volt bevétel vagy kiadás.</li>
              <li>Az oszlopfejre kattintva lent az adott hónap ügyfelei és munkatársai látszanak.</li>
            </ul>
          )}
        </div>
      </div>

      {/* ügyfelek és munkatársak a kiválasztott hónapban */}
      {cur && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(440px,1fr))', gap: 18, alignItems: 'start' }}>
          <div style={{ ...card, overflow: 'hidden' }}>
            <div style={{ padding: '14px 16px 10px', display: 'flex', flexDirection: 'column', gap: 2 }}>
              <b style={{ font: `700 15px ${FONT_H}`, color: C.navy }}>Ügyfelek · {monthLong(cur.ym)}</b>
              <span style={{ font: `500 12px ${FONT}`, color: C.muted }}>
                Akinek ebben a hónapban számlája vagy befizetése volt · alternatív nevek egy sorban · névre kattintva: adatlap
              </span>
            </div>
            <div style={{ overflow: 'auto' }}>
              <div style={{ display: 'grid', gridTemplateColumns: 'minmax(170px,1.5fr) 56px 96px 100px 100px 84px', minWidth: 610 }}>
                {['Projekt', 'Óra', 'Munkaköltség', 'Bevétel', 'Fedezet', 'Ft / óra'].map((x, i) => (
                  <div key={x} style={{ ...th, textAlign: i ? 'right' : 'left' }}>
                    {x}
                  </div>
                ))}
                {invoiced.map((p) => projRow(p))}
                {!invoiced.length && (
                  <div style={{ ...td, gridColumn: '1 / -1', textAlign: 'left', color: C.muted }}>
                    Ebben a hónapban egy ügyfélnek sem volt számlája vagy befizetése.
                  </div>
                )}
                {noInv.length > 0 && (
                  <>
                    <button
                      onClick={() => setShowNoInv((x) => !x)}
                      style={{
                        ...td,
                        gridColumn: '1 / -1',
                        textAlign: 'left',
                        border: 0,
                        borderTop: `1px solid ${C.line3}`,
                        background: C.negBg,
                        cursor: 'pointer',
                        color: C.neg,
                        fontWeight: 600,
                        fontSize: 12.5,
                        whiteSpace: 'normal',
                      }}
                    >
                      {showNoInv ? '▾' : '›'} Számla nélküli munka ebben a hónapban: {noInv.length} projekt · {h(noInvMin)} óra ·{' '}
                      {fmt(noInv.reduce((a, p) => a + p.laborCost, 0))} Ft munkaköltség
                    </button>
                    {showNoInv && noInv.map((p) => projRow(p, true))}
                  </>
                )}
              </div>
            </div>
          </div>
          <div style={{ ...card, overflow: 'hidden' }}>
            <div style={{ padding: '14px 16px 10px', font: `700 15px ${FONT_H}`, color: C.navy }}>Munkatársak · {monthLong(cur.ym)}</div>
            <div style={{ overflow: 'auto' }}>
              <div style={{ display: 'grid', gridTemplateColumns: 'minmax(140px,1.3fr) 60px 120px 100px 84px', minWidth: 510 }}>
                {['Név', 'Óra', 'Ügyfélóra', 'Költség', 'Órakölts.'].map((x, i) => (
                  <div key={x} style={{ ...th, textAlign: i ? 'right' : 'left' }} title={x === 'Órakölts.' ? 'Óraköltség' : undefined}>
                    {x}
                  </div>
                ))}
                {cur.people.map((p) => {
                  const share = p.minutes ? p.billableMinutes / p.minutes : 0;
                  return (
                    <div key={p.key} style={{ display: 'contents' }}>
                      <div style={{ ...td, textAlign: 'left', fontWeight: 700, color: C.navy }}>{p.name}</div>
                      <div style={td}>{p.minutes ? h(p.minutes) : '–'}</div>
                      <div style={td}>
                        {p.minutes ? (
                          <span style={{ display: 'inline-flex', flexDirection: 'column', alignItems: 'flex-end', gap: 3 }}>
                            <span>
                              {h(p.billableMinutes)} <span style={{ color: C.muted }}>({Math.round(share * 100)}%)</span>
                            </span>
                            <span style={{ width: 64, height: 4, borderRadius: R.sm, background: C.line3, overflow: 'hidden', display: 'block' }}>
                              <span style={{ display: 'block', height: '100%', width: `${share * 100}%`, background: C.blue }} />
                            </span>
                          </span>
                        ) : (
                          '–'
                        )}
                      </div>
                      <div style={{ ...td, fontWeight: 600 }}>{p.cost ? fmt(p.cost) : '–'}</div>
                      <div style={{ ...td, color: C.muted }}>{p.hourly ? fmt(Math.round(p.hourly)) : '–'}</div>
                    </div>
                  );
                })}
                {!cur.people.length && (
                  <div style={{ ...td, gridColumn: '1 / -1', textAlign: 'left', color: C.muted }}>Ebben a hónapban nincs feltöltött munkaidő.</div>
                )}
              </div>
            </div>
            {noWork.length > 0 && (
              <div style={{ borderTop: `1px solid ${C.line3}`, padding: '10px 16px', display: 'flex', flexDirection: 'column', gap: 2 }}>
                {noWork.map((e) => (
                  <button
                    key={e.key}
                    type="button"
                    onClick={() => {
                      setSrcOpen(true);
                      setTimeout(() => srcRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 0);
                    }}
                    style={{ border: 0, background: 'transparent', padding: 0, cursor: 'pointer', textAlign: 'left', font: `500 12.5px ${FONT}`, color: C.neg }}
                  >
                    {e.name}: még nincs munkaidő feltöltve ↓
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>
      )}

      {/* adatforrás: munkatársanként a munkaidő-tábla (Drive-link / fájl) és a költség-kategória */}
      <div ref={srcRef} style={{ ...card, overflow: 'hidden' }}>
        <div style={{ padding: '14px 16px', display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
          <button
            type="button"
            onClick={() => setSrcOpen((x) => !x)}
            style={{ border: 0, background: 'transparent', padding: 0, cursor: 'pointer', font: `700 15px ${FONT_H}`, color: C.navy }}
          >
            {srcOpen ? '▾' : '▸'} Adatforrás · munkaidő-táblák
          </button>
          <span style={{ flex: 1, minWidth: 220, font: `500 12px/1.4 ${FONT}`, color: C.muted }}>
            Clockify-export („ÉÉÉÉ.HH-Feladatok” lapok · Tag · Projekt · Idő) · a Google-táblát „Bárki, akinek megvan a link – Megtekintő” megosztásra kell
            állítani
          </span>
          {isAdmin && withSheet.length > 0 && (
            <Pill kind="dark" onClick={() => !busy && refresh(withSheet)}>
              {busy ? `Frissítés: ${employees.find((e) => e.key === busy)?.name}…` : `↻ Drive XLS frissítése – mind (${withSheet.length})`}
            </Pill>
          )}
        </div>
        {srcOpen && (
          <>
            {employees.length === 0 && (
              <div style={{ borderTop: `1px solid ${C.line3}`, padding: '12px 16px', color: C.muted, font: `500 13px ${FONT}` }}>
                Még nincs munkatárs – add hozzá lent, majd töltsd fel a munkaidő XLS-t.
              </div>
            )}
            {employees.map((emp) => {
              const ms = new Set(worktime.filter((w) => w.employee === emp.key).map((w) => w.ym));
              const last = [...ms].sort().pop();
              return (
                <div
                  key={emp.key}
                  style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap', borderTop: `1px solid ${C.line3}`, padding: '10px 16px' }}
                >
                  <b style={{ width: 140, font: `700 13.5px ${FONT}`, color: C.navy }}>{emp.name}</b>
                  {isAdmin ? (
                    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                      <span style={{ font: `500 12px ${FONT}`, color: C.muted }}>költség:</span>
                      <LeafSelect
                        ix={ix}
                        section="out"
                        value={emp.cost_leaf_id}
                        onChange={(id) => saveEmp({ key: emp.key, name: emp.name, cost_leaf_id: id }, `${emp.name}: költség → ${ix.leafById[id]?.label}`)}
                        style={{ width: 190, height: 34 }}
                      />
                    </span>
                  ) : (
                    <span style={{ font: `500 12.5px ${FONT}`, color: C.ink }}>költség: {emp.cost_leaf_id ? ix.leafById[emp.cost_leaf_id]?.label : '–'}</span>
                  )}
                  <span style={{ width: 170, font: `500 12.5px ${FONT}`, color: ms.size ? C.muted : C.neg, fontWeight: ms.size ? 500 : 600 }}>
                    {ms.size ? `${ms.size} hónap · utolsó: ${monthLabel(last!).toLowerCase()} ${last!.slice(0, 4)}` : 'még nincs munkaidő'}
                  </span>
                  {isAdmin && (
                    <input
                      value={urls[emp.key] ?? emp.sheet_url ?? ''}
                      onChange={(e) => setUrls((u) => ({ ...u, [emp.key]: e.target.value }))}
                      onBlur={(e) => {
                        const v = e.target.value.trim();
                        if (v === (emp.sheet_url || '')) return;
                        if (v && !sheetIdOf(v)) return showToast({ msg: 'Ez nem Google-táblázat (Drive XLS) link.', error: true });
                        saveEmp(
                          { key: emp.key, name: emp.name, cost_leaf_id: emp.cost_leaf_id, sheet_url: v } as any,
                          `${emp.name}: Drive-tábla ${v ? 'mentve' : 'törölve'}`,
                        );
                      }}
                      placeholder="Drive XLS (Google-táblázat) link"
                      style={{ ...inputStyle, height: 34, flex: '1 1 220px', borderColor: emp.sheet_url ? undefined : C.neg }}
                    />
                  )}
                  {emp.sheet_url && (
                    <a href={emp.sheet_url} target="_blank" rel="noreferrer" style={{ font: `600 12.5px ${FONT}`, color: C.blueDark, textDecoration: 'none' }}>
                      Megnyitás ↗
                    </a>
                  )}
                  {isAdmin && emp.sheet_url && (
                    <Pill small kind="primary" onClick={() => !busy && refresh([emp])}>
                      {busy === emp.key ? 'Frissítés…' : '↻ Frissítés'}
                    </Pill>
                  )}
                  {isAdmin && (
                    <label style={{ cursor: 'pointer' }} title="Ha nincs Drive-link: a letöltött XLS fájl feltöltése">
                      <input
                        type="file"
                        accept=".xlsx,.xls"
                        style={{ display: 'none' }}
                        onChange={(ev) => ev.target.files?.[0] && upload(emp, ev.target.files[0]).finally(() => (ev.target.value = ''))}
                      />
                      <span style={{ font: `600 12px ${FONT}`, color: C.blueDark, textDecoration: 'underline' }}>fájl feltöltése</span>
                    </label>
                  )}
                </div>
              );
            })}
            {isAdmin && (
              <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', borderTop: `1px solid ${C.line3}`, padding: '10px 16px 14px' }}>
                <input
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                  placeholder="Új munkatárs neve"
                  style={{ ...inputStyle, height: 36, width: 260 }}
                />
                <Pill
                  onClick={() => {
                    const n = newName.trim();
                    if (!n) return;
                    const leaf = guessLeaf(n);
                    saveEmp(
                      { name: n, cost_leaf_id: leaf },
                      `${n} hozzáadva${leaf ? ` · költség: ${ix.leafById[leaf]?.label}` : ' – válaszd ki a költség kategóriáját'}`,
                    ).then(() => setNewName(''));
                  }}
                >
                  + Munkatárs
                </Pill>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
