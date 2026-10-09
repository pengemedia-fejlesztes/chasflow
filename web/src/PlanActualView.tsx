// Havi terv–tény összesítő: tervezett / tényleges bevétel, kiadás, profit és eltérés.
import { useMemo, useState } from 'react';
import { addMonths, fmt, monthLong, monthRange } from '../../shared/model';
import { planVsActual, pvaProfit, type PvaMonth } from '../../shared/planactual';
import { useStore } from './store';
import { C, FONT, FONT_H, Seg, card } from './ui';

type Range = 'around' | 'past' | 'future';

/** eltérés szövege + szín: good = a pozitív eltérés kedvező-e (bevétel, profit) */
function Diff({ v, good, muted }: { v: number | null; good: boolean; muted?: boolean }) {
  if (v === null) return <span style={{ color: C.faint }}>–</span>;
  const bad = good ? v < 0 : v > 0;
  const color = !Math.round(v) ? C.muted : bad ? C.neg : C.blueDark;
  return (
    <span style={{ color: muted ? C.muted : color, fontWeight: 600 }}>
      {v > 0 ? '+' : v < 0 ? '−' : ''}
      {fmt(Math.abs(v))}
    </span>
  );
}

const n = (v: number, show: boolean) => (show ? fmt(v) : '–');

export function PlanActualView({ mobile }: { mobile?: boolean }) {
  const { data, ix } = useStore();
  const [range, setRange] = useState<Range>('around');
  const months = useMemo(() => {
    const cur = ix.cur;
    if (range === 'past') return monthRange(addMonths(cur, -12), cur);
    if (range === 'future') return monthRange(cur, addMonths(cur, 12));
    return monthRange(addMonths(cur, -3), addMonths(cur, 6));
  }, [range, ix.cur]);
  const rows = useMemo(() => planVsActual(data.entries, ix.sectionOf, months), [data.entries, ix, months]);
  // összesen: csak a már elkezdődött, tervvel rendelkező hónapok (különben nincs mihez mérni)
  const tot = rows
    .filter((r) => r.ym <= ix.cur && r.hasPlan)
    .reduce((a, r) => ({ planIn: a.planIn + r.planIn, actIn: a.actIn + r.actIn, planOut: a.planOut + r.planOut, actOut: a.actOut + r.actOut }), {
      planIn: 0,
      actIn: 0,
      planOut: 0,
      actOut: 0,
    });

  const status = (r: PvaMonth) => (r.ym > ix.cur ? 'terv' : r.ym === ix.cur ? 'folyamatban' : r.hasPlan ? 'lezárt' : 'nincs terv');
  const actShown = (r: PvaMonth) => r.ym <= ix.cur;
  const diffOf = (r: PvaMonth, a: number, p: number) => (r.ym <= ix.cur && r.hasPlan ? a - p : null);

  const head = (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      {!mobile && (
        <div>
          <div style={{ font: `600 12px ${FONT}`, letterSpacing: '.18em', textTransform: 'uppercase', color: C.blue, marginBottom: 8 }}>Havi összesítő</div>
          <h1 style={{ margin: 0, font: `700 30px/1.05 ${FONT_H}`, color: C.navy }}>Terv vs. tény</h1>
        </div>
      )}
      <span style={{ font: `400 13px/1.5 ${FONT}`, color: C.muted }}>
        <b>Terv</b>: a hónap összes terve (teljesült és nyitott, ajánlatok nélkül). <b>Tény</b>: a ténylegesen befolyt és kifizetett összeg. <b>Profit</b> =
        bevétel − kiadás. Piros: kedvezőtlen eltérés. Az eltérés csak azokban a hónapokban látszik, amelyekre volt terv (a tervek 2026 októberétől vannak).
      </span>
      <Seg
        small
        value={range}
        onChange={setRange}
        options={[
          ['around', 'Elmúlt 3 + jövő 6 hó'],
          ['past', 'Elmúlt 12 hó'],
          ['future', 'Következő 12 hó'],
        ]}
      />
    </div>
  );

  if (mobile)
    return (
      <div style={{ padding: '14px 16px 24px', display: 'flex', flexDirection: 'column', gap: 12 }}>
        {head}
        {rows.map((r) => {
          const p = pvaProfit(r);
          const line = (label: string, plan: number, act: number, good: boolean, bold?: boolean) => (
            <div style={{ display: 'grid', gridTemplateColumns: '70px 1fr 1fr 1fr', gap: 6, alignItems: 'baseline', fontVariantNumeric: 'tabular-nums' }}>
              <span style={{ font: `${bold ? 700 : 600} 12.5px ${FONT}`, color: C.navy }}>{label}</span>
              <span style={{ font: `500 13px ${FONT}`, color: C.ink, textAlign: 'right' }}>{n(plan, r.hasPlan)}</span>
              <span style={{ font: `${bold ? 700 : 600} 13px ${FONT}`, color: C.navy, textAlign: 'right' }}>{n(act, actShown(r))}</span>
              <span style={{ font: `500 13px ${FONT}`, textAlign: 'right' }}>
                <Diff v={diffOf(r, act, plan)} good={good} muted={r.ym === ix.cur} />
              </span>
            </div>
          );
          return (
            <div key={r.ym} style={{ ...card, padding: '12px 14px', display: 'flex', flexDirection: 'column', gap: 7 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
                <b style={{ font: `700 15px ${FONT_H}`, color: C.navy }}>{monthLong(r.ym)}</b>
                <span style={{ font: `600 11.5px ${FONT}`, color: r.ym === ix.cur ? C.blue : C.muted }}>{status(r)}</span>
              </div>
              <div
                style={{ display: 'grid', gridTemplateColumns: '70px 1fr 1fr 1fr', gap: 6, font: `600 10.5px ${FONT}`, color: C.muted, letterSpacing: '.06em' }}
              >
                <span />
                <span style={{ textAlign: 'right' }}>TERV</span>
                <span style={{ textAlign: 'right' }}>TÉNY</span>
                <span style={{ textAlign: 'right' }}>ELTÉRÉS</span>
              </div>
              {line('Bevétel', r.planIn, r.actIn, true)}
              {line('Kiadás', r.planOut, r.actOut, false)}
              <div style={{ borderTop: `1px solid ${C.line}` }} />
              {line('Profit', p.plan, p.act, true, true)}
              {r.ym === ix.cur && (r.openIn || r.openOut) ? (
                <span style={{ font: `500 12px ${FONT}`, color: C.muted }}>
                  Még nyitott: +{fmt(r.openIn)} bevétel, −{fmt(r.openOut)} kiadás
                </span>
              ) : null}
            </div>
          );
        })}
      </div>
    );

  const th = (t: string, right = true, group?: boolean): React.ReactNode => (
    <th
      style={{
        padding: '8px 10px',
        textAlign: right ? 'right' : 'left',
        font: `600 11.5px ${FONT}`,
        color: group ? '#fff' : C.muted,
        background: group ? C.navy : C.bg,
        letterSpacing: '.04em',
        whiteSpace: 'nowrap',
      }}
    >
      {t}
    </th>
  );
  const td = (v: React.ReactNode, opts: { bold?: boolean; left?: boolean; sep?: boolean } = {}) => (
    <td
      style={{
        padding: '9px 10px',
        textAlign: opts.left ? 'left' : 'right',
        font: `${opts.bold ? 700 : 500} 13px ${FONT}`,
        color: C.ink,
        borderTop: `1px solid ${C.line}`,
        borderLeft: opts.sep ? `2px solid ${C.line2}` : undefined,
        fontVariantNumeric: 'tabular-nums',
        whiteSpace: 'nowrap',
      }}
    >
      {v}
    </td>
  );
  const totP = pvaProfit(tot);
  return (
    <div style={{ padding: '28px 32px 120px', display: 'flex', flexDirection: 'column', gap: 16 }}>
      {head}
      <div style={{ ...card, overflow: 'auto' }}>
        <table style={{ borderCollapse: 'collapse', width: '100%', minWidth: 980 }}>
          <thead>
            <tr>
              <th style={{ background: C.navy }} colSpan={2} />
              <th colSpan={3} style={{ background: C.navy, color: '#fff', font: `700 12.5px ${FONT}`, padding: 8, borderLeft: `2px solid ${C.navy3}` }}>
                Bevétel
              </th>
              <th colSpan={3} style={{ background: C.navy, color: '#fff', font: `700 12.5px ${FONT}`, padding: 8, borderLeft: `2px solid ${C.navy3}` }}>
                Kiadás
              </th>
              <th colSpan={3} style={{ background: C.navy, color: '#fff', font: `700 12.5px ${FONT}`, padding: 8, borderLeft: `2px solid ${C.navy3}` }}>
                Profit
              </th>
            </tr>
            <tr>
              {th('Hónap', false)}
              {th('', false)}
              {['Terv', 'Tény', 'Eltérés', 'Terv', 'Tény', 'Eltérés', 'Terv', 'Tény', 'Eltérés'].map((t, i) => (
                <th
                  key={i}
                  style={{
                    padding: '8px 10px',
                    textAlign: 'right',
                    font: `600 11.5px ${FONT}`,
                    color: C.muted,
                    background: C.bg,
                    borderLeft: i % 3 === 0 ? `2px solid ${C.line2}` : undefined,
                  }}
                >
                  {t}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const p = pvaProfit(r);
              return (
                <tr key={r.ym} style={{ background: r.ym === ix.cur ? '#F7FAFD' : undefined }}>
                  {td(<b style={{ color: C.navy }}>{monthLong(r.ym)}</b>, { left: true })}
                  {td(<span style={{ font: `600 11.5px ${FONT}`, color: r.ym === ix.cur ? C.blue : C.muted }}>{status(r)}</span>, { left: true })}
                  {td(n(r.planIn, r.hasPlan), { sep: true })}
                  {td(n(r.actIn, actShown(r)), { bold: true })}
                  {td(<Diff v={diffOf(r, r.actIn, r.planIn)} good muted={r.ym === ix.cur} />)}
                  {td(n(r.planOut, r.hasPlan), { sep: true })}
                  {td(n(r.actOut, actShown(r)), { bold: true })}
                  {td(<Diff v={diffOf(r, r.actOut, r.planOut)} good={false} muted={r.ym === ix.cur} />)}
                  {td(n(p.plan, r.hasPlan), { sep: true })}
                  {td(<span style={{ color: actShown(r) && p.act < 0 ? C.neg : C.navy }}>{n(p.act, actShown(r))}</span>, { bold: true })}
                  {td(<Diff v={diffOf(r, p.act, p.plan)} good muted={r.ym === ix.cur} />)}
                </tr>
              );
            })}
            <tr style={{ background: C.bg }}>
              {td(<b>Összesen</b>, { left: true })}
              {td(<span style={{ font: `500 11.5px ${FONT}`, color: C.muted }}>tervezett hónapok, eddig</span>, { left: true })}
              {td(fmt(tot.planIn), { sep: true, bold: true })}
              {td(fmt(tot.actIn), { bold: true })}
              {td('')}
              {td(fmt(tot.planOut), { sep: true, bold: true })}
              {td(fmt(tot.actOut), { bold: true })}
              {td('')}
              {td(fmt(totP.plan), { sep: true, bold: true })}
              {td(<span style={{ color: totP.act < 0 ? C.neg : C.navy }}>{fmt(totP.act)}</span>, { bold: true })}
              {td('')}
            </tr>
          </tbody>
        </table>
      </div>
      {rows.some((r) => r.ym === ix.cur && (r.openIn || r.openOut)) && (
        <span style={{ font: `400 12.5px ${FONT}`, color: C.muted }}>
          {monthLong(ix.cur)}: még nyitott terv +{fmt(rows.find((r) => r.ym === ix.cur)!.openIn)} Ft bevétel, −{fmt(rows.find((r) => r.ym === ix.cur)!.openOut)}{' '}
          Ft kiadás – a tény a hónap végéig nő.
        </span>
      )}
    </div>
  );
}
