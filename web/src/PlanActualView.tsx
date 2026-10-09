// Havi terv–tény összesítő: tervezett / tényleges bevétel, kiadás, profit és eltérés.
// Lezárt hónap: a hónap végén egyszer rögzített pillanatkép; folyó hónap: reggel 5-kor (vagy kézzel) frissül;
// jövőbeli hónap: az aktuális tervekből.
import { useMemo, useState } from 'react';
import { addMonths, fmt, monthLong, monthRange } from '../../shared/model';
import { planStart, planVsActual, type PvaMonth } from '../../shared/planactual';
import { api } from './api';
import { DivergingBars } from './Bars';
import { useStore } from './store';
import { C, FONT, FONT_H, Pill, Seg, card, relTime } from './ui';

type Range = 'around' | 'past' | 'future';
interface Row {
  ym: string;
  planIn: number;
  planOut: number;
  actIn: number;
  actOut: number;
  openIn: number;
  openOut: number;
  hasPlan: boolean;
  source: 'closed' | 'current' | 'live' | 'none';
  at: number | null;
}

/** eltérés szövege + szín: good = a pozitív eltérés kedvező-e (bevétel, profit) */
function Diff({ v, good, muted }: { v: number | null; good: boolean; muted?: boolean }) {
  if (v === null) return <span style={{ color: C.faint }}>–</span>;
  const bad = good ? v < 0 : v > 0;
  const color = !Math.round(v) ? C.muted : bad ? C.neg : '#1A7340';
  return (
    <span style={{ color: muted ? C.muted : color, fontWeight: 700 }}>
      {v > 0 ? '+' : v < 0 ? '−' : ''}
      {fmt(Math.abs(v))}
    </span>
  );
}
const n = (v: number, show: boolean) => (show ? fmt(v) : '–');

export function PlanActualView({ mobile }: { mobile?: boolean }) {
  const { data, ix, run, canEdit, isAdmin } = useStore();
  const [range, setRange] = useState<Range>('around');
  const [offers, setOffers] = useState(false);
  const months = useMemo(() => {
    const cur = ix.cur;
    if (range === 'past') return monthRange(addMonths(cur, -12), cur);
    if (range === 'future') return monthRange(cur, addMonths(cur, 12));
    return monthRange(addMonths(cur, -3), addMonths(cur, 6));
  }, [range, ix.cur]);
  const start = useMemo(() => planStart(data.entries), [data.entries]);
  const live = useMemo(() => new Map(planVsActual(data.entries, ix.sectionOf, months).map((r) => [r.ym, r])), [data.entries, ix, months]);
  const snap = useMemo(() => new Map((data.monthStats || []).map((s) => [s.ym, s])), [data.monthStats]);
  const curSnap = snap.get(ix.cur);

  const rows: Row[] = months.map((ym) => {
    const l = live.get(ym) as PvaMonth;
    const s = snap.get(ym);
    const before = !start || ym < start;
    if (s && ym <= ix.cur)
      return {
        ym,
        planIn: s.plan_in + (offers ? s.offer_in : 0),
        planOut: s.plan_out + (offers ? s.offer_out : 0),
        actIn: s.act_in,
        actOut: s.act_out,
        openIn: l.openIn,
        openOut: l.openOut,
        hasPlan: true,
        source: s.closed ? 'closed' : 'current',
        at: s.computed_at,
      };
    return {
      ym,
      planIn: l.planIn + (offers ? l.offerIn : 0),
      planOut: l.planOut + (offers ? l.offerOut : 0),
      actIn: l.actIn,
      actOut: l.actOut,
      openIn: l.openIn,
      openOut: l.openOut,
      hasPlan: !before && (l.hasPlan || ym > ix.cur),
      source: before ? 'none' : 'live',
      at: null,
    };
  });
  const prof = (r: Row) => ({ plan: r.planIn - r.planOut, act: r.actIn - r.actOut });
  const tot = rows
    .filter((r) => r.ym <= ix.cur && r.hasPlan)
    .reduce((a, r) => ({ planIn: a.planIn + r.planIn, actIn: a.actIn + r.actIn, planOut: a.planOut + r.planOut, actOut: a.actOut + r.actOut }), {
      planIn: 0,
      actIn: 0,
      planOut: 0,
      actOut: 0,
    });
  const status = (r: Row) =>
    r.source === 'none' ? 'nincs terv' : r.ym > ix.cur ? 'terv' : r.ym === ix.cur ? 'folyamatban' : r.source === 'closed' ? 'lezárt' : 'nincs lezárva';
  const actShown = (r: Row) => r.ym <= ix.cur;
  const diffOf = (r: Row, a: number, p: number) => (r.ym <= ix.cur && r.hasPlan ? a - p : null);
  const refresh = (all = false) => run(() => api('/api/stats/refresh', { body: { all } }), all ? 'Minden hónap újraszámolva' : 'Folyó hónap frissítve');

  const chart = (
    <DivergingBars
      title={`Havi profit${offers ? ' (ajánlatokkal)' : ''}`}
      points={rows.map((r) => {
        const p = prof(r);
        const fut = r.ym > ix.cur;
        return {
          ym: r.ym,
          v: fut ? p.plan : p.act,
          plan: !fut && r.hasPlan ? p.plan : null,
          future: fut,
          note: fut ? 'terv szerint' : r.ym === ix.cur ? 'eddig' : undefined,
        };
      })}
    />
  );

  const head = (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <span style={{ font: `400 13px/1.5 ${FONT}`, color: C.muted }}>
        <b>Terv</b>: a hónap tervei (teljesült és nyitott). <b>Tény</b>: befolyt / kifizetett összeg. <b>Profit</b> = bevétel − kiadás. Zöld: kedvező, piros:
        kedvezőtlen eltérés. A lezárt hónap a hónap végén egyszer rögzül, a folyó hónap minden reggel 5-kor frissül.
      </span>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
        <Seg
          small
          value={range}
          onChange={setRange}
          options={[
            ['around', '−3 / +6 hó'],
            ['past', 'Elmúlt 12 hó'],
            ['future', 'Következő 12 hó'],
          ]}
        />
        <button
          onClick={() => setOffers(!offers)}
          style={{
            height: 32,
            borderRadius: 999,
            padding: '0 12px',
            border: `1.5px solid ${offers ? C.navy : C.line2}`,
            background: offers ? C.navy : '#fff',
            color: offers ? '#fff' : C.muted,
            font: `600 12.5px ${FONT}`,
            cursor: 'pointer',
          }}
        >
          {offers ? '✓ ' : ''}Ajánlatokkal
        </button>
      </div>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', font: `500 12.5px ${FONT}`, color: C.muted }}>
        <span>Folyó hónap frissítve: {curSnap ? relTime(curSnap.computed_at) : 'még nem'}</span>
        {canEdit && (
          <Pill small kind="light" onClick={() => refresh()}>
            ↻ Frissítés most
          </Pill>
        )}
        {isAdmin && (
          <Pill small onClick={() => confirm('A lezárt hónapokat is újraszámolja a mostani adatokból. Folytatod?') && refresh(true)}>
            Lezártak újraszámolása
          </Pill>
        )}
      </div>
    </div>
  );

  if (mobile)
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        {head}
        {chart}
        {rows.map((r) => {
          const p = prof(r);
          const line = (label: string, plan: number, act: number, good: boolean, bold?: boolean) => (
            <div style={{ display: 'grid', gridTemplateColumns: '64px 1fr 1fr 1fr', gap: 6, alignItems: 'baseline', fontVariantNumeric: 'tabular-nums' }}>
              <span style={{ font: `${bold ? 700 : 600} 12.5px ${FONT}`, color: C.navy }}>{label}</span>
              <span style={{ font: `500 13px ${FONT}`, color: C.ink, textAlign: 'right' }}>{n(plan, r.hasPlan)}</span>
              <span style={{ font: `${bold ? 700 : 600} 13px ${FONT}`, color: C.navy, textAlign: 'right' }}>{n(act, actShown(r))}</span>
              <span style={{ font: `500 13px ${FONT}`, textAlign: 'right' }}>
                <Diff v={diffOf(r, act, plan)} good={good} muted={r.ym === ix.cur} />
              </span>
            </div>
          );
          const dp = diffOf(r, p.act, p.plan);
          return (
            <div
              key={r.ym}
              style={{
                ...card,
                padding: '12px 14px',
                display: 'flex',
                flexDirection: 'column',
                gap: 7,
                borderLeft: `4px solid ${r.ym > ix.cur || dp === null || r.ym === ix.cur ? C.line2 : dp < 0 ? '#E36B57' : '#1A7340'}`,
              }}
            >
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
                <b style={{ font: `700 15px ${FONT_H}`, color: C.navy }}>{monthLong(r.ym)}</b>
                <span style={{ font: `600 11.5px ${FONT}`, color: r.ym === ix.cur ? C.blue : C.muted }}>{status(r)}</span>
              </div>
              <div
                style={{ display: 'grid', gridTemplateColumns: '64px 1fr 1fr 1fr', gap: 6, font: `600 10.5px ${FONT}`, color: C.muted, letterSpacing: '.06em' }}
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
  const totP = { plan: tot.planIn - tot.planOut, act: tot.actIn - tot.actOut };
  const grpTh = (t: string) => (
    <th colSpan={3} style={{ background: C.navy, color: '#fff', font: `700 12.5px ${FONT}`, padding: 8, borderLeft: `2px solid ${C.navy3}` }}>
      {t}
    </th>
  );
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      {head}
      {chart}
      <div style={{ ...card, overflow: 'auto' }}>
        <table style={{ borderCollapse: 'collapse', width: '100%', minWidth: 980 }}>
          <thead>
            <tr>
              <th style={{ background: C.navy }} colSpan={2} />
              {grpTh('Bevétel')}
              {grpTh('Kiadás')}
              {grpTh('Profit')}
            </tr>
            <tr>
              {['Hónap', ''].map((t, i) => (
                <th key={i} style={{ padding: '8px 10px', textAlign: 'left', font: `600 11.5px ${FONT}`, color: C.muted, background: C.bg }}>
                  {t}
                </th>
              ))}
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
              const p = prof(r);
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
              {td(<Diff v={tot.actIn - tot.planIn} good />)}
              {td(fmt(tot.planOut), { sep: true, bold: true })}
              {td(fmt(tot.actOut), { bold: true })}
              {td(<Diff v={tot.actOut - tot.planOut} good={false} />)}
              {td(fmt(totP.plan), { sep: true, bold: true })}
              {td(<span style={{ color: totP.act < 0 ? C.neg : C.navy }}>{fmt(totP.act)}</span>, { bold: true })}
              {td(<Diff v={totP.act - totP.plan} good />)}
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  );
}
