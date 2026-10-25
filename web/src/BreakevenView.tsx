// Fedezeti pont: munkatársanként feltöltött havi munkaidő (Clockify-szerű XLS) + a cashflow tényei →
// munkaköltség projektenként, projektfedezet, a cég havi fedezeti pontja; letölthető XLS.
import { useMemo, useState } from 'react';
import { addMonths, fmt, monthLabel, monthLong, monthRange } from '../../shared/model';
import { namesMatch } from '../../shared/billingopay';
import { partnerIdOf } from '../../shared/partners';
import { breakeven, parseWorkSheets, type BreakevenMonth, type Employee } from '../../shared/worktime';
import { api } from './api';
import { rowsOfSheet } from './sheetCore';
import { useStore } from './store';
import { C, FONT, FONT_H, LeafSelect, Pill, card, eyebrow, inputStyle } from './ui';

const h = (min: number) => (min / 60).toLocaleString('hu-HU', { maximumFractionDigits: 1 });
const pct = (r: number) => (r * 100).toLocaleString('hu-HU', { maximumFractionDigits: 1 }) + '%';

export function BreakevenView() {
  const { ix, data, run, isAdmin, showToast } = useStore();
  const employees = data.employees || [];
  const worktime = data.worktime || [];
  const months = useMemo(() => monthRange(addMonths(ix.cur, -11), ix.cur), [ix.cur]);
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
  const [sel, setSel] = useState(() => [...months].reverse().find((m) => worktime.some((w) => w.ym === m)) || ix.cur);
  const cur = report.find((r) => r.ym === sel);
  const [newName, setNewName] = useState('');

  const outLeaves = ix.leaves.filter((l) => !l.archived && ix.sectionOf(l.id) === 'out');
  const guessLeaf = (name: string) =>
    outLeaves.find((l) => namesMatch(name, l.label) || l.label.toLowerCase().includes(name.toLowerCase().split(' ')[0]))?.id || null;
  const saveEmp = (e: { key?: string; name: string; cost_leaf_id: string | null }, msg: string) =>
    run(() => api('/api/employees', { method: 'PUT', body: e }), msg);

  const upload = async (emp: Employee, file: File) => {
    try {
      const XLSX = await import('xlsx');
      const wb = XLSX.read(await file.arrayBuffer(), { type: 'array', raw: true, cellDates: false, cellFormula: false, cellStyles: false });
      const sheets: Record<string, unknown[][]> = {};
      for (const n of wb.SheetNames) if (/-Feladatok$/i.test(n)) sheets[n] = rowsOfSheet(XLSX, wb.Sheets[n]);
      const rows = parseWorkSheets(sheets);
      if (!rows.length) throw new Error('Nem találtam „ÉÉÉÉ.HH-Feladatok” lapot (Tag · Projekt · Idő oszlopokkal).');
      const nMonths = new Set(rows.map((r) => r.ym)).size;
      await run(
        () => api('/api/worktime/import', { body: { employee: emp.key, rows } }),
        `${emp.name}: ${nMonths} hónap munkaideje betöltve (${h(rows.reduce((a, r) => a + r.minutes, 0))} óra)`,
      );
    } catch (e: any) {
      showToast({ msg: e.message || 'Nem sikerült beolvasni a fájlt.', error: true });
    }
  };

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
        <b style={{ font: `700 15px ${FONT_H}`, color: C.navy }}>Munkatársak</b>
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
                <label style={{ marginLeft: 'auto', cursor: 'pointer' }}>
                  <input
                    type="file"
                    accept=".xlsx,.xls"
                    style={{ display: 'none' }}
                    onChange={(ev) => ev.target.files?.[0] && upload(emp, ev.target.files[0]).finally(() => (ev.target.value = ''))}
                  />
                  <span
                    style={{ display: 'inline-block', borderRadius: 999, background: C.blue, color: '#fff', padding: '7px 14px', font: `600 12.5px ${FONT}` }}
                  >
                    Munkaidő XLS feltöltése
                  </span>
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

      <div style={{ ...card, overflow: 'auto' }}>
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: `minmax(220px,1.4fr) repeat(${report.length}, minmax(100px,1fr))`,
            minWidth: 240 + report.length * 104,
          }}
        >
          <div style={{ ...th, textAlign: 'left' }}>Havi összesítő</div>
          {report.map((r) => (
            <button
              key={r.ym}
              onClick={() => setSel(r.ym)}
              style={{ ...th, border: 0, cursor: 'pointer', color: r.ym === sel ? C.blue : C.navy, textDecoration: r.ym === sel ? 'underline' : 'none' }}
              title="Részletek: projektek és munkatársak"
            >
              {monthLabel(r.ym)} {r.ym.slice(2, 4)}
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
                      background: r.ym === sel ? '#F2F8FC' : undefined,
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
            <div style={{ padding: '12px 14px', font: `700 15px ${FONT_H}`, color: C.navy }}>Projektek · {monthLong(cur.ym)}</div>
            <div style={{ display: 'grid', gridTemplateColumns: 'minmax(160px,1.4fr) 70px 110px 110px 110px', minWidth: 560 }}>
              {['Projekt', 'Óra', 'Munkaköltség', 'Bevétel', 'Fedezet'].map((x, i) => (
                <div key={x} style={{ ...th, textAlign: i ? 'right' : 'left' }}>
                  {x}
                </div>
              ))}
              {cur.projects.map((p) => (
                <div key={p.project} style={{ display: 'contents' }}>
                  <div style={{ ...td, textAlign: 'left', whiteSpace: 'normal' }}>
                    <b style={{ color: C.navy }}>{p.project}</b>
                    <span style={{ color: C.muted, fontSize: 11.5 }}>
                      {p.leaf ? (ix.leafById[p.leaf]?.label !== p.project ? ` · ${ix.leafById[p.leaf]?.label}` : '') : ' · belső'}
                    </span>
                  </div>
                  <div style={td}>{p.minutes ? h(p.minutes) : '–'}</div>
                  <div style={td}>{p.laborCost ? fmt(p.laborCost) : '–'}</div>
                  <div style={td}>{p.revenue ? fmt(p.revenue) : '–'}</div>
                  <div style={{ ...td, fontWeight: 700, color: p.leaf ? (p.revenue - p.laborCost < 0 ? C.neg : '#2E7D4F') : C.muted }}>
                    {p.leaf ? fmt(p.revenue - p.laborCost) : '–'}
                  </div>
                </div>
              ))}
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
