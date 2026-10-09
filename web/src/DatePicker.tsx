// Saját dátumválasztó (a natív naptár helyett): magyar hét (hétfővel kezdődik), ünnepnapok és hétvégék halványan,
// gyorsgombok (Ma, Holnap, Jövő hétfő, Hónap utolsó munkanapja). Mobilon alsó lap, asztalon középre nyíló ablak.
import { useEffect, useState, type CSSProperties } from 'react';
import { MSL } from '../../shared/model';
import { addDays, isWorkday, lastWorkday, mondayAfter } from '../../shared/workdays';
import { useBack } from './back';
import { C, FONT, FONT_H } from './ui';

const WD = ['H', 'K', 'Sze', 'Cs', 'P', 'Szo', 'V'];
const WDL = ['vasárnap', 'hétfő', 'kedd', 'szerda', 'csütörtök', 'péntek', 'szombat'];
const iso = (y: number, m: number, d: number) => `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
const todayIso = () => {
  const t = new Date();
  return iso(t.getFullYear(), t.getMonth() + 1, t.getDate());
};

export function DateField(props: { value: string; onChange: (v: string) => void; min?: string; big?: boolean; style?: CSSProperties }) {
  const [open, setOpen] = useState(false);
  const [y, m, d] = props.value.split('-');
  const wd = WDL[new Date(props.value + 'T12:00:00').getDay()] || '';
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          height: props.big ? 48 : 40,
          border: `1.5px solid ${open ? C.blue : C.line2}`,
          borderRadius: props.big ? 12 : 10,
          padding: '0 12px',
          background: '#fff',
          cursor: 'pointer',
          textAlign: 'left',
          ...props.style,
        }}
      >
        <span style={{ font: `700 ${props.big ? 16 : 14}px ${FONT_H}`, color: C.navy, fontVariantNumeric: 'tabular-nums' }}>
          {y}. {m}. {d}.
        </span>
        <span style={{ font: `500 13px ${FONT}`, color: C.muted, flex: 1 }}>{wd}</span>
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke={C.blueDark} strokeWidth="2" strokeLinecap="round" aria-hidden>
          <rect x="3" y="5" width="18" height="16" rx="3" />
          <path d="M3 10h18M8 3v4M16 3v4" />
        </svg>
      </button>
      {open && (
        <CalendarSheet
          value={props.value}
          min={props.min}
          onClose={() => setOpen(false)}
          onPick={(v) => {
            props.onChange(v);
            setOpen(false);
          }}
        />
      )}
    </>
  );
}

function CalendarSheet({ value, min, onPick, onClose }: { value: string; min?: string; onPick: (v: string) => void; onClose: () => void }) {
  const [vy, setVy] = useState(Number(value.slice(0, 4)));
  const [vm, setVm] = useState(Number(value.slice(5, 7)));
  const mobile = typeof window !== 'undefined' && window.innerWidth < 700;
  const today = todayIso();
  useBack(true, onClose);
  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [onClose]);
  const shift = (n: number) => {
    const t = new Date(vy, vm - 1 + n, 1);
    setVy(t.getFullYear());
    setVm(t.getMonth() + 1);
  };
  const first = new Date(vy, vm - 1, 1);
  const lead = (first.getDay() + 6) % 7; // hétfő = 0
  const days = new Date(vy, vm, 0).getDate();
  const cells: (number | null)[] = [...Array(lead).fill(null), ...Array.from({ length: days }, (_, i) => i + 1)];
  while (cells.length % 7) cells.push(null);
  const ym = `${vy}-${String(vm).padStart(2, '0')}`;
  const quick: [string, string][] = [
    ['Ma', today],
    ['Holnap', addDays(today, 1)],
    ['Jövő hétfő', mondayAfter(today, 1)],
    ['Hó utolsó munkanapja', lastWorkday(ym)],
  ];
  const pick = (v: string) => (!min || v >= min) && onPick(v);
  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 80,
        background: 'rgba(0,32,64,.45)',
        display: 'flex',
        alignItems: mobile ? 'flex-end' : 'center',
        justifyContent: 'center',
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: mobile ? '100%' : 380,
          background: '#fff',
          borderRadius: mobile ? '24px 24px 0 0' : 18,
          padding: mobile ? '10px 18px calc(env(safe-area-inset-bottom) + 18px)' : 20,
          display: 'flex',
          flexDirection: 'column',
          gap: 12,
          boxShadow: '0 20px 50px rgba(0,32,64,.25)',
        }}
      >
        {mobile && <i style={{ alignSelf: 'center', width: 40, height: 5, borderRadius: 999, background: C.line2 }} />}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <b style={{ flex: 1, font: `700 18px ${FONT_H}`, color: C.navy }}>
            {vy}. {MSL[vm - 1]}
          </b>
          {[-1, 1].map((n) => (
            <button
              key={n}
              type="button"
              onClick={() => shift(n)}
              aria-label={n < 0 ? 'Előző hónap' : 'Következő hónap'}
              style={{
                width: 40,
                height: 40,
                borderRadius: 12,
                border: `1.5px solid ${C.line2}`,
                background: '#fff',
                color: C.navy,
                font: `700 18px ${FONT}`,
                cursor: 'pointer',
              }}
            >
              {n < 0 ? '‹' : '›'}
            </button>
          ))}
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', gap: 4 }}>
          {WD.map((w, i) => (
            <span key={w} style={{ textAlign: 'center', font: `600 11.5px ${FONT}`, color: i >= 5 ? C.faint : C.muted, padding: '2px 0 4px' }}>
              {w}
            </span>
          ))}
          {cells.map((dd, i) => {
            if (!dd) return <span key={i} />;
            const v = iso(vy, vm, dd);
            const sel = v === value;
            const isToday = v === today;
            const off = !isWorkday(v);
            const dis = !!min && v < min;
            return (
              <button
                key={i}
                type="button"
                disabled={dis}
                onClick={() => pick(v)}
                style={{
                  height: 42,
                  borderRadius: 12,
                  border: isToday && !sel ? `1.5px solid ${C.blue}` : '1.5px solid transparent',
                  background: sel ? C.navy : 'transparent',
                  color: sel ? '#fff' : dis ? C.line2 : off ? C.faint : C.navy,
                  font: `${sel || isToday ? 700 : 600} 15px ${FONT}`,
                  fontVariantNumeric: 'tabular-nums',
                  cursor: dis ? 'default' : 'pointer',
                }}
              >
                {dd}
              </button>
            );
          })}
        </div>
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          {quick.map(([l, v]) => (
            <button
              key={l}
              type="button"
              onClick={() => pick(v)}
              style={{
                height: 36,
                borderRadius: 999,
                padding: '0 12px',
                border: 0,
                background: v === value ? C.navy : C.bg2,
                color: v === value ? '#fff' : C.blueDark,
                font: `600 13px ${FONT}`,
                cursor: 'pointer',
              }}
            >
              {l}
            </button>
          ))}
        </div>
        <button
          type="button"
          onClick={onClose}
          style={{
            height: 46,
            borderRadius: 999,
            border: `1.5px solid ${C.line2}`,
            background: '#fff',
            color: C.navy,
            font: `600 14.5px ${FONT}`,
            cursor: 'pointer',
          }}
        >
          Mégse
        </button>
      </div>
    </div>
  );
}
