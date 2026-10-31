// Mobil: a hónap ütemezése – a hónap bevételei és kiadásai napokra bontva (tény, terv, ajánlat, becslés külön jelölve),
// fent szűrőkkel; oldalra húzva előző / következő hónap. A becslés a tényekből számolt, még nem tervezett rendszeres tétel.
import { useRef, useState } from 'react';
import { fmt, monthLong } from '../../shared/model';
import type { Entry, Section } from '../../shared/types';
import { CalendarSheet } from './DatePicker';
import { itemLabel } from './MonthList';
import { C, FONT, FONT_H, R } from './ui';

export type SchedKind = 'actual' | 'plan' | 'offer' | 'est';
const WD = ['vasárnap', 'hétfő', 'kedd', 'szerda', 'csütörtök', 'péntek', 'szombat'];
const KIND_LABEL: Record<SchedKind, string> = { actual: 'Tény', plan: 'Terv', offer: 'Ajánlat', est: 'Becslés' };

/** a sor fajtája: tény (vagy késznek jelölt terv), nyitott terv, ajánlat, becslés */
export const schedKind = (e: Entry): SchedKind => (e.source === 'estimate' ? 'est' : e.kind === 'actual' || e.done ? 'actual' : e.tentative ? 'offer' : 'plan');

export function MonthSchedule(p: {
  m: string;
  today: string;
  entries: Entry[];
  sectionOf: (leaf: string) => Section;
  leafLabel: (leaf: string) => string;
  onMonth: (delta: number) => void;
  onOpen?: (e: Entry) => void;
  /** a dátumra koppintva: nyitott terv új dátuma */
  onDate?: (e: Entry, date: string) => void;
  title?: string;
}) {
  const touch = useRef<{ x: number; y: number } | null>(null);
  const [pick, setPick] = useState<Entry | null>(null);
  const [show, setShowS] = useState<Record<SchedKind, boolean>>(() => {
    try {
      return { actual: true, plan: true, offer: true, est: true, ...JSON.parse(localStorage.getItem('cf_sched_kinds') || '{}') };
    } catch {
      return { actual: true, plan: true, offer: true, est: true };
    }
  });
  const setShow = (k: SchedKind) => {
    const n = { ...show, [k]: !show[k] };
    setShowS(n);
    try {
      localStorage.setItem('cf_sched_kinds', JSON.stringify(n));
    } catch {}
  };
  const all = [...p.entries].sort((a, b) => a.date.localeCompare(b.date) || b.amount - a.amount);
  const counts = { actual: 0, plan: 0, offer: 0, est: 0 } as Record<SchedKind, number>;
  all.forEach((e) => counts[schedKind(e)]++);
  const rows = all.filter((e) => show[schedKind(e)]);
  const sum = (s: Section) => rows.filter((e) => p.sectionOf(e.leaf_id) === s).reduce((a, e) => a + e.amount, 0);
  const days: [string, Entry[]][] = [];
  for (const e of rows) {
    if (days.length && days[days.length - 1][0] === e.date) days[days.length - 1][1].push(e);
    else days.push([e.date, [e]]);
  }
  const badge = (e: Entry): [string, string, string] => {
    const k = schedKind(e);
    if (k === 'est') return ['BECSLÉS', '#6B5BA8', '#F1EEFA'];
    if (k === 'offer') return ['AJÁNLAT', C.offer, C.offerBg];
    if (k === 'actual') return [e.kind === 'plan' ? '✓ KÉSZ' : 'TÉNY', C.blueDark, C.bg2];
    return e.date < p.today ? ['LEJÁRT', C.neg, C.negBg] : ['TERV', C.muted, C.bg2];
  };
  return (
    <div
      onTouchStart={(ev) => (touch.current = { x: ev.touches[0].clientX, y: ev.touches[0].clientY })}
      onTouchEnd={(ev) => {
        const t = touch.current;
        touch.current = null;
        if (!t) return;
        const dx = ev.changedTouches[0].clientX - t.x;
        const dy = ev.changedTouches[0].clientY - t.y;
        // vízszintes húzás: balra = következő hónap, jobbra = előző
        if (Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy) * 1.5) p.onMonth(dx < 0 ? 1 : -1);
      }}
      style={{ display: 'flex', flexDirection: 'column', gap: 10 }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <button
          aria-label="Előző hónap"
          onClick={() => p.onMonth(-1)}
          style={{ width: 36, height: 36, borderRadius: 999, border: `1px solid ${C.line2}`, background: '#fff', color: C.navy, font: `700 18px ${FONT}` }}
        >
          ‹
        </button>
        <span style={{ flex: 1, textAlign: 'center', font: `700 17px ${FONT_H}`, color: C.navy }}>{monthLong(p.m)}</span>
        <button
          aria-label="Következő hónap"
          onClick={() => p.onMonth(1)}
          style={{ width: 36, height: 36, borderRadius: 999, border: `1px solid ${C.line2}`, background: '#fff', color: C.navy, font: `700 18px ${FONT}` }}
        >
          ›
        </button>
      </div>
      {/* szűrők: mi látszódjon – tény, terv, ajánlat, becslés (korrekció) */}
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
        {(Object.keys(KIND_LABEL) as SchedKind[]).map((k) => (
          <button
            key={k}
            onClick={() => setShow(k)}
            style={{
              height: 34,
              borderRadius: 999,
              padding: '0 12px',
              border: show[k] ? 0 : `1.5px solid ${C.line2}`,
              background: show[k] ? C.navy : '#fff',
              color: show[k] ? '#fff' : C.muted,
              font: `600 13px ${FONT}`,
            }}
          >
            {show[k] ? '✓ ' : ''}
            {KIND_LABEL[k]} <span style={{ opacity: 0.7 }}>{counts[k]}</span>
          </button>
        ))}
      </div>
      <div style={{ font: `600 13px ${FONT}`, color: C.muted }}>
        {rows.length} tétel · be <b style={{ color: C.inc }}>+{fmt(sum('in'))}</b> · ki <b style={{ color: C.neg }}>−{fmt(Math.abs(sum('out')))}</b> · egyenleg{' '}
        <b style={{ color: sum('in') + sum('out') < 0 ? C.neg : C.navy }}>{fmt(sum('in') + sum('out'))}</b>
      </div>
      {!rows.length && (
        <div
          style={{ background: '#fff', border: `1px dashed ${C.line2}`, borderRadius: R.lg, padding: '20px 14px', font: `500 13.5px ${FONT}`, color: C.muted }}
        >
          Ebben a hónapban nincs (a szűrőknek megfelelő) tétel.
        </div>
      )}
      {days.map(([d, es]) => (
        <div key={d} style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, padding: '0 4px' }}>
            <b style={{ font: `700 13.5px ${FONT_H}`, color: d < p.today ? C.navy : C.blueDark }}>
              {d.slice(5).replace('-', '.')}. {WD[new Date(d + 'T12:00:00').getDay()]}
            </b>
            <span style={{ flex: 1 }} />
            <span style={{ font: `600 12px ${FONT}`, color: C.muted, fontVariantNumeric: 'tabular-nums' }}>{fmt(es.reduce((a, e) => a + e.amount, 0))}</span>
          </div>
          <div style={{ background: '#fff', border: `1px solid ${C.line}`, borderRadius: R.lg, overflow: 'hidden' }}>
            {es.map((e, i) => {
              const sec = p.sectionOf(e.leaf_id);
              const partner = p.leafLabel(e.leaf_id);
              const item = itemLabel(e.name, partner);
              const [bl, bc, bb] = badge(e);
              const est = e.source === 'estimate';
              const canDate = !!p.onDate && e.kind === 'plan' && !e.done && !est;
              return (
                <div
                  key={e.id}
                  onClick={() => !est && p.onOpen?.(e)}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 10,
                    padding: '9px 12px',
                    borderTop: i ? `1px solid ${C.line3}` : 0,
                    cursor: p.onOpen && !est ? 'pointer' : undefined,
                    background: est ? '#FBFAFE' : undefined,
                  }}
                >
                  <span
                    role={canDate ? 'button' : undefined}
                    title={canDate ? 'Dátum módosítása' : undefined}
                    onClick={(ev) => {
                      if (!canDate) return;
                      ev.stopPropagation();
                      setPick(e);
                    }}
                    style={{
                      width: 34,
                      flex: 'none',
                      textAlign: 'center',
                      padding: '4px 0',
                      borderRadius: R.md,
                      outline: canDate ? `1px dashed ${C.line2}` : undefined,
                      font: `800 14px ${FONT_H}`,
                      color: bl === 'LEJÁRT' ? C.neg : C.navy,
                    }}
                  >
                    {Number(e.date.slice(8))}.
                  </span>
                  <span style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 2 }}>
                    <span style={{ font: `600 14px ${FONT}`, color: C.ink, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                      {partner}
                    </span>
                    <span style={{ display: 'flex', gap: 6, alignItems: 'center', minWidth: 0 }}>
                      <span
                        style={{
                          flex: 'none',
                          padding: '1px 7px',
                          borderRadius: 999,
                          background: bb,
                          color: bc,
                          border: est ? '1px dashed #B7AEDB' : undefined,
                          font: `700 10px ${FONT}`,
                          letterSpacing: '.04em',
                        }}
                      >
                        {bl}
                      </span>
                      {item && (
                        <span style={{ font: `500 12px ${FONT}`, color: C.muted, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                          {item}
                        </span>
                      )}
                    </span>
                  </span>
                  <b
                    style={{
                      font: `700 14px ${FONT}`,
                      color: sec === 'in' ? C.inc : C.neg,
                      fontVariantNumeric: 'tabular-nums',
                      whiteSpace: 'nowrap',
                      opacity: e.tentative || est ? 0.65 : 1,
                      fontStyle: est ? 'italic' : undefined,
                    }}
                  >
                    {sec === 'in' ? '+' : '−'}
                    {fmt(Math.abs(e.amount))}
                  </b>
                </div>
              );
            })}
          </div>
        </div>
      ))}
      {pick && (
        <CalendarSheet
          value={pick.date}
          onClose={() => setPick(null)}
          onPick={(v) => {
            const e = pick;
            setPick(null);
            if (v !== e.date) p.onDate?.(e, v);
          }}
        />
      )}
    </div>
  );
}
