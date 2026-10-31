// Fedezeti pont: munkatársanként feltöltött havi munkaidő (Clockify-szerű XLS) + a cashflow tényei →
// munkaköltség projektenként, projektfedezet, a cég havi fedezeti pontja; letölthető XLS.
import { useMemo, useState } from 'react';
import { addMonths, fmt, monthLabel, monthLong, monthRange } from '../../shared/model';
import { namesMatch } from '../../shared/billingopay';
import { partnerIdOf } from '../../shared/partners';
import { breakeven, parseWorkSheets, sheetIdOf, type BreakevenMonth, type Employee, type ProjectMonth } from '../../shared/worktime';

const MONTH_HU = ['január', 'február', 'március', 'április', 'május', 'június', 'július', 'augusztus', 'szeptember', 'október', 'november', 'december'];
import { api } from './api';
import { rowsOfSheet } from './sheetCore';
import { useStore } from './store';
import { C, FONT, FONT_H, LeafSelect, Pill, card, eyebrow, inputStyle } from './ui';

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

export function BreakevenView() {
  const { ix, data, run, isAdmin, showToast, openPartner } = useStore();
  const employees = data.employees || [];
  const worktime = data.worktime || [];
  // 12 hónapos ablak, évenként lapozható vissza
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
  const [newName, setNewName] = useState('');
  const [showNoInv, setShowNoInv] = useState(false);
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
  const years = [...new Set(months.map((m) => m.slice(0, 4)))];
  const yearBg = (ym: string) => (years.indexOf(ym.slice(0, 4)) % 2 ? '#F4F1FA' : '#EEF5FB');

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
      ['Fedezet (bevétel − közvetlen munkaköltség)', ...report.map((r) => r.contribution)],
      ['Fedezeti hányad', ...report.map((r) => (r.revenue ? Math.round(r.ratio * 1000) / 10 : null))],
      ['Fix költség (kiadás − közvetlen munkaköltség)', ...report.map((r) => r.fixed)],
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

  const th = { padding: '8px 10px', font: `700 12px ${FONT}`, color: C.navy, textAlign: 'right' as const, background: C.bg, whiteSpace: 'nowrap' as const };
  const td = {
    padding: '7px 10px',
    font: `500 13px ${FONT}`,
    textAlign: 'right' as const,
    borderTop: `1px solid ${C.line3}`,
    fontVariantNumeric: 'tabular-nums' as const,
    whiteSpace: 'nowrap' as const,
  };
  const lines: [string, (r: BreakevenMonth) => string, string?][] = [
    ['Bevétel', (r) => fmt(r.revenue)],
    ['Összes kiadás', (r) => fmt(r.expenses)],
    ['Közvetlen munkaköltség', (r) => fmt(r.directLabor), 'ügyfélprojektekre jutó bér (az idő arányában)'],
    ['Fedezet', (r) => fmt(r.contribution), 'bevétel − közvetlen munkaköltség'],
    ['Fedezeti hányad', (r) => (r.revenue ? pct(r.ratio) : '–')],
    ['Fix költség', (r) => fmt(r.fixed), 'minden más kiadás (iroda, szoftver, belső munkaidő …)'],
    ['Fedezeti pont', (r) => (r.breakeven == null ? '–' : fmt(r.breakeven)), 'ennyi bevétel kell, hogy ne legyen veszteség'],
    ['Biztonsági sáv', (r) => (r.margin == null ? '–' : (r.margin > 0 ? '+' : '') + fmt(r.margin))],
    ['Ledolgozott óra', (r) => (r.minutes ? h(r.minutes) : '–')],
    ['Kihasználtság', (r) => (r.minutes ? pct(r.billableMinutes / r.minutes) : '–'), 'ügyfélprojekten töltött idő aránya'],
    ['Bevétel / ügyfélóra', (r) => (r.revenuePerBillableHour ? fmt(r.revenuePerBillableHour) : '–')],
  ];

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

  const projRow = (p: ProjectMonth, muted?: boolean) => (
    <div key={(p.leaf || '') + p.project} style={{ display: 'contents' }}>
      <div style={{ ...td, textAlign: 'left', whiteSpace: 'normal', background: muted ? '#FAFBFC' : undefined }}>
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
              ? ` · munkaidőben: ${p.names.filter((n) => n !== p.project).join(', ')}`
              : ''
            : ' · belső / nincs párosítva'}
        </span>
        {/* belső / párosítatlan projekt → ügyfélhez rendelés: a név az ügyfél alternatív neve lesz, a munkaidő onnantól ott számít */}
        {!p.leaf && isAdmin && (
          <select
            value=""
            onChange={(ev) => ev.target.value && attach(p.project, ev.target.value)}
            title="A projekt ehhez az ügyfélhez tartozik (alternatív név lesz az adatlapján)"
            style={{ marginLeft: 8, height: 26, maxWidth: 170, borderRadius: 8, border: `1px solid ${C.line2}`, font: `500 12px ${FONT}`, color: C.blueDark }}
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
      <div style={td}>{p.minutes ? h(p.minutes) : '–'}</div>
      <div style={td}>{p.laborCost ? fmt(p.laborCost) : '–'}</div>
      <div style={td}>{p.revenue ? fmt(p.revenue) : '–'}</div>
      <div style={{ ...td, fontWeight: 700, color: p.leaf ? (p.revenue - p.laborCost < 0 ? C.neg : '#2E7D4F') : C.muted }}>
        {p.leaf ? fmt(p.revenue - p.laborCost) : '–'}
      </div>
    </div>
  );

  return (
    <div style={{ padding: '28px 32px 120px', display: 'flex', flexDirection: 'column', gap: 18 }}>
      <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', gap: 16, flexWrap: 'wrap' }}>
        <div>
          <div style={{ ...eyebrow, color: C.blue, marginBottom: 8 }}>Munkaidő · költség · bevétel</div>
          <h1 style={{ margin: 0, font: `700 30px/1.05 ${FONT_H}`, color: C.navy }}>Fedezeti pont</h1>
        </div>
        <Pill kind="dark" onClick={download}>
          XLS letöltés
        </Pill>
      </div>
      <span style={{ font: `400 13px/1.5 ${FONT}`, color: C.muted }}>
        A munkatársak havi munkaidejét (Clockify-export: „ÉÉÉÉ.HH-Feladatok” lapok · Tag · Projekt · Idő) itt töltöd fel. A munkatárs költsége a cashflow-ban
        hozzá rendelt kiadási kategória tényeiből jön, és a ledolgozott idő arányában oszlik meg a projektek között. Az ügyfélprojektekre jutó bér a változó
        költség, minden más kiadás fix; a fedezeti pont = fix költség / fedezeti hányad.
      </span>

      <div style={{ ...card, padding: '14px 18px', display: 'flex', flexDirection: 'column', gap: 10 }}>
        <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
          <b style={{ font: `700 15px ${FONT_H}`, color: C.navy, flex: 1 }}>Munkatársak</b>
          {isAdmin && withSheet.length > 0 && (
            <Pill kind="dark" onClick={() => !busy && refresh(withSheet)}>
              {busy ? `Frissítés: ${employees.find((e) => e.key === busy)?.name}…` : `↻ Drive XLS frissítése – mind (${withSheet.length})`}
            </Pill>
          )}
        </div>
        <span style={{ font: `500 12px ${FONT}`, color: C.muted }}>
          A Google-táblázatot „Bárki, akinek megvan a link – Megtekintő” megosztásra kell állítani, különben a program nem tudja letölteni.
        </span>
        {employees.length === 0 && (
          <span style={{ color: C.muted, font: `500 13px ${FONT}` }}>Még nincs munkatárs – add hozzá lent, majd töltsd fel a munkaidő XLS-t.</span>
        )}
        {employees.map((emp) => {
          const ms = new Set(worktime.filter((w) => w.employee === emp.key).map((w) => w.ym));
          const last = [...ms].sort().pop();
          return (
            <div key={emp.key} style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap', borderTop: `1px solid ${C.line3}`, paddingTop: 10 }}>
              <b style={{ minWidth: 150, font: `700 14px ${FONT}`, color: C.navy }}>{emp.name}</b>
              <span style={{ font: `500 12.5px ${FONT}`, color: C.muted }}>költsége:</span>
              {isAdmin ? (
                <LeafSelect
                  ix={ix}
                  section="out"
                  value={emp.cost_leaf_id}
                  onChange={(id) => saveEmp({ key: emp.key, name: emp.name, cost_leaf_id: id }, `${emp.name}: költség → ${ix.leafById[id]?.label}`)}
                  style={{ width: 240, height: 36 }}
                />
              ) : (
                <span>{emp.cost_leaf_id ? ix.leafById[emp.cost_leaf_id]?.label : '–'}</span>
              )}
              <span style={{ font: `500 12.5px ${FONT}`, color: C.muted }}>
                {ms.size ? `${ms.size} hónap munkaideje · utolsó: ${monthLabel(last!)} ${last!.slice(0, 4)}` : 'még nincs munkaidő'}
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
                <a href={emp.sheet_url} target="_blank" rel="noreferrer" style={{ font: `600 12.5px ${FONT}`, color: C.blueDark }}>
                  Megnyitás ↗
                </a>
              )}
              {isAdmin && emp.sheet_url && (
                <Pill small kind="primary" onClick={() => !busy && refresh([emp])}>
                  {busy === emp.key ? 'Frissítés…' : '↻ Drive XLS frissítése'}
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
                  <span style={{ font: `600 12px ${FONT}`, color: C.muted, textDecoration: 'underline' }}>fájl feltöltése</span>
                </label>
              )}
            </div>
          );
        })}
        {isAdmin && (
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', borderTop: `1px solid ${C.line3}`, paddingTop: 10 }}>
            <input
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              placeholder="Új munkatárs neve (pl. Zuban Erna)"
              style={{ ...inputStyle, height: 38, width: 280 }}
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
      </div>

      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <Pill small onClick={() => setEndYm(addMonths(endYm, -12))}>
          ‹ Előző 12 hónap
        </Pill>
        <Pill small onClick={() => setEndYm(addMonths(endYm, -1))}>
          ‹ 1 hónap
        </Pill>
        <b style={{ font: `700 13.5px ${FONT}`, color: C.navy }}>
          {monthLong(months[0])} – {monthLong(endYm)}
        </b>
        {endYm < ix.cur && (
          <>
            <Pill small onClick={() => setEndYm(addMonths(endYm, 1))}>
              1 hónap ›
            </Pill>
            <Pill small onClick={() => setEndYm(ix.cur)}>
              Mai hónapig ›
            </Pill>
          </>
        )}
        <span style={{ font: `500 12px ${FONT}`, color: C.muted }}>A hónapra kattintva lent a projektjei és munkatársai látszanak.</span>
      </div>
      <div style={{ ...card, overflow: 'auto' }}>
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: `minmax(220px,1.4fr) repeat(${report.length}, minmax(112px,1fr))`,
            minWidth: 240 + report.length * 116,
          }}
        >
          <div style={{ ...th, textAlign: 'left' }}>Havi összesítő</div>
          {report.map((r) => (
            <button
              key={r.ym}
              onClick={() => setSel(r.ym)}
              style={{
                ...th,
                border: 0,
                cursor: 'pointer',
                background: r.ym === sel ? '#DCEBF7' : yearBg(r.ym),
                color: r.ym === sel ? C.blue : C.navy,
                textDecoration: r.ym === sel ? 'underline' : 'none',
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'flex-end',
                lineHeight: 1.2,
              }}
              title="Részletek: projektek és munkatársak"
            >
              <span style={{ font: `600 10.5px ${FONT}`, color: C.muted }}>{r.ym.slice(0, 4)}.</span>
              {MONTH_HU[Number(r.ym.slice(5, 7)) - 1]}
            </button>
          ))}
          {lines.map(([label, f, hint]) => (
            <div key={label} style={{ display: 'contents' }}>
              <div style={{ ...td, textAlign: 'left', fontWeight: label === 'Fedezeti pont' ? 800 : 600, color: C.navy }} title={hint}>
                {label}
              </div>
              {report.map((r) => {
                const v = f(r);
                const neg = (label === 'Biztonsági sáv' && (r.margin ?? 0) < 0) || (label === 'Fedezet' && r.contribution < 0);
                return (
                  <div
                    key={r.ym}
                    style={{
                      ...td,
                      fontWeight: label === 'Fedezeti pont' ? 800 : 500,
                      color: neg ? C.neg : label === 'Biztonsági sáv' && (r.margin ?? 0) > 0 ? '#2E7D4F' : C.ink,
                      background: r.ym === sel ? '#F2F8FC' : years.indexOf(r.ym.slice(0, 4)) % 2 ? '#FBFAFD' : undefined,
                    }}
                  >
                    {v}
                  </div>
                );
              })}
            </div>
          ))}
        </div>
      </div>

      {cur && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(420px,1fr))', gap: 18 }}>
          <div style={{ ...card, overflow: 'auto' }}>
            <div style={{ padding: '12px 14px', display: 'flex', flexDirection: 'column', gap: 2 }}>
              <b style={{ font: `700 15px ${FONT_H}`, color: C.navy }}>Ügyfelek · {monthLong(cur.ym)}</b>
              <span style={{ font: `500 12px ${FONT}`, color: C.muted }}>
                Akinek ebben a hónapban számlája vagy befizetése volt. A partner alternatív nevei (pl. Kalmia → Pharmazone) egy sorba kerülnek. Névre kattintva:
                adatlap.
              </span>
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: 'minmax(160px,1.4fr) 70px 110px 110px 110px', minWidth: 560 }}>
              {['Projekt', 'Óra', 'Munkaköltség', 'Bevétel', 'Fedezet'].map((x, i) => (
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
                      background: C.bg,
                      cursor: 'pointer',
                      color: C.navy,
                      fontWeight: 600,
                    }}
                  >
                    {showNoInv ? '▾' : '▸'} Számla nélküli munka ebben a hónapban: {noInv.length} projekt · {h(noInv.reduce((a, p) => a + p.minutes, 0))} óra ·{' '}
                    {fmt(noInv.reduce((a, p) => a + p.laborCost, 0))} Ft munkaköltség
                  </button>
                  {showNoInv && noInv.map((p) => projRow(p, true))}
                </>
              )}
            </div>
          </div>
          <div style={{ ...card, overflow: 'auto' }}>
            <div style={{ padding: '12px 14px', font: `700 15px ${FONT_H}`, color: C.navy }}>Munkatársak · {monthLong(cur.ym)}</div>
            <div style={{ display: 'grid', gridTemplateColumns: 'minmax(140px,1.2fr) 70px 90px 110px 100px', minWidth: 510 }}>
              {['Név', 'Óra', 'Ügyfélóra', 'Költség', 'Óraköltség'].map((x, i) => (
                <div key={x} style={{ ...th, textAlign: i ? 'right' : 'left' }}>
                  {x}
                </div>
              ))}
              {cur.people.map((p) => (
                <div key={p.key} style={{ display: 'contents' }}>
                  <div style={{ ...td, textAlign: 'left', fontWeight: 700, color: C.navy }}>{p.name}</div>
                  <div style={td}>{p.minutes ? h(p.minutes) : '–'}</div>
                  <div style={td}>{p.minutes ? `${h(p.billableMinutes)} (${pct(p.billableMinutes / p.minutes)})` : '–'}</div>
                  <div style={td}>{p.cost ? fmt(p.cost) : '–'}</div>
                  <div style={td}>{p.hourly ? fmt(Math.round(p.hourly)) : '–'}</div>
                </div>
              ))}
              {!cur.people.length && (
                <div style={{ ...td, gridColumn: '1 / -1', textAlign: 'left', color: C.muted }}>Ebben a hónapban nincs feltöltött munkaidő.</div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
