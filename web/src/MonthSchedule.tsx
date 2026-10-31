// Mobil főoldal: a hónap ütemezése – a hónap összes bevétele és kiadása dátum szerint, oldalra húzva előző / következő hónap.
import { useRef, useState } from 'react';
import { CalendarSheet } from './DatePicker';
import { fmt, monthLong } from '../../shared/model';
import type { Entry, Section } from '../../shared/types';
import { itemLabel } from './MonthList';
import { C, FONT, FONT_H } from './ui';

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
  /** összecsukható: alapból csak a fejléc és az összesítő látszik, koppintásra nyílik ki (az állapot megmarad) */
  collapsible?: string;
}) {
  const touch = useRef<{ x: number; y: number } | null>(null);
  const [pick, setPick] = useState<Entry | null>(null);
  const [open, setOpenS] = useState(() => {
    if (!p.collapsible) return true;
    try {
      return localStorage.getItem('cf_sched_' + p.collapsible) === '1';
    } catch {
      return false;
    }
  });
  const toggle = () => {
    if (!p.collapsible) return;
    setOpenS(!open);
    try {
      localStorage.setItem('cf_sched_' + p.collapsible, open ? '0' : '1');
    } catch {}
  };
  const rows = [...p.entries].sort((a, b) => a.date.localeCompare(b.date) || b.amount - a.amount);
  const inc = rows.filter((e) => p.sectionOf(e.leaf_id) === 'in').reduce((a, e) => a + e.amount, 0);
  const out = rows.filter((e) => p.sectionOf(e.leaf_id) === 'out').reduce((a, e) => a + e.amount, 0);
  const status = (e: Entry): [string, string] =>
    e.kind === 'actual'
      ? ['tény', C.blueDark]
      : e.done
        ? ['✓ teljesült', '#1A7340']
        : e.tentative
          ? ['ajánlat', '#8A6D1C']
          : e.date < p.today
            ? ['lejárt', C.neg]
            : ['terv', C.muted];
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
      style={{ display: 'flex', flexDirection: 'column', gap: 8 }}
    >
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, padding: '0 4px' }}>
        <button
          aria-label="Előző hónap"
          onClick={() => p.onMonth(-1)}
          style={{ border: 0, background: 'transparent', color: C.blueDark, font: `700 18px ${FONT}`, padding: 0 }}
        >
          ‹
        </button>
        <span
          onClick={toggle}
          style={{
            flex: 1,
            font: `700 13px ${FONT_H}`,
            color: C.navy,
            letterSpacing: '.04em',
            textTransform: 'uppercase',
            cursor: p.collapsible ? 'pointer' : undefined,
          }}
        >
          {p.collapsible ? (open ? '▾ ' : '▸ ') : ''}
          {p.title || 'Ütemezés'} · {monthLong(p.m)}
        </span>
        <button
          aria-label="Következő hónap"
          onClick={() => p.onMonth(1)}
          style={{ border: 0, background: 'transparent', color: C.blueDark, font: `700 18px ${FONT}`, padding: 0 }}
        >
          ›
        </button>
      </div>
      <div
        onClick={toggle}
        style={{ font: `600 12.5px ${FONT}`, color: C.muted, padding: '0 4px', marginTop: -4, cursor: p.collapsible ? 'pointer' : undefined }}
      >
        {rows.length} tétel · be <b style={{ color: '#1A7340' }}>+{fmt(inc)}</b> · ki <b style={{ color: C.neg }}>−{fmt(Math.abs(out))}</b>
        {open ? ' · oldalra húzva előző / következő hónap' : ' · koppints a megnyitáshoz'}
      </div>
      {open && (
        <div style={{ background: '#fff', border: `1px solid ${C.line}`, borderRadius: 14, overflow: 'hidden' }}>
          {!rows.length && <div style={{ padding: '18px 14px', font: `500 13.5px ${FONT}`, color: C.muted }}>Ebben a hónapban nincs tétel.</div>}
          {rows.map((e, i) => {
            const sec = p.sectionOf(e.leaf_id);
            const partner = p.leafLabel(e.leaf_id);
            const item = itemLabel(e.name, partner);
            const [st, stc] = status(e);
            const canDate = !!p.onDate && e.kind === 'plan' && !e.done;
            return (
              <div
                key={e.id}
                onClick={() => p.onOpen?.(e)}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 10,
                  padding: '9px 12px',
                  borderTop: i ? `1px solid ${C.line3}` : 0,
                  cursor: p.onOpen ? 'pointer' : undefined,
                }}
              >
                {/* dátum minden sorban; nyitott tervnél koppintásra naptár */}
                <span
                  role={canDate ? 'button' : undefined}
                  onClick={(ev) => {
                    if (!canDate) return;
                    ev.stopPropagation();
                    setPick(e);
                  }}
                  style={{
                    width: 40,
                    flex: 'none',
                    textAlign: 'center',
                    padding: '3px 0',
                    borderRadius: 8,
                    outline: canDate ? `1px dashed ${C.line2}` : undefined,
                    font: `800 14px ${FONT_H}`,
                    color: e.date < p.today && e.kind === 'plan' && !e.done ? C.neg : C.navy,
                    lineHeight: 1.1,
                  }}
                >
                  {Number(e.date.slice(8))}.
                  <small style={{ display: 'block', font: `600 9.5px ${FONT}`, color: C.muted }}>
                    {['V', 'H', 'K', 'Sze', 'Cs', 'P', 'Szo'][new Date(e.date + 'T12:00:00').getDay()]}
                  </small>
                </span>
                <span style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
                  <span style={{ font: `600 14px ${FONT}`, color: C.ink, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{partner}</span>
                  <span style={{ font: `500 12px ${FONT}`, color: C.muted, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                    {item ? `${item} · ` : ''}
                    <span style={{ color: stc, fontWeight: 600 }}>{st}</span>
                  </span>
                </span>
                <b
                  style={{
                    font: `700 14px ${FONT}`,
                    color: sec === 'in' ? '#1A7340' : C.neg,
                    fontVariantNumeric: 'tabular-nums',
                    whiteSpace: 'nowrap',
                    opacity: e.tentative ? 0.7 : 1,
                  }}
                >
                  {sec === 'in' ? '+' : '−'}
                  {fmt(Math.abs(e.amount))}
                </b>
              </div>
            );
          })}
        </div>
      )}
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
