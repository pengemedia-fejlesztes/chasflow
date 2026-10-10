// Havi eltérés-oszlopdiagram: pozitív = zöld (nulla fölött), negatív = piros (nulla alatt).
// A jelet az oszlop iránya és az előjeles felirat is hordozza (színtévesztőknek is olvasható).
// Opcionális tervjelölő (vízszintes vonal) – így a terv és a tény eltérése is látszik.
import { useState } from 'react';
import { fmt, fmtK, monthLabel } from '../../shared/model';
import { C, FONT, FONT_H, card } from './ui';

export const POS = '#1A7340';
export const NEG = '#E36B57';

export interface BarPoint {
  ym: string;
  v: number;
  /** tervérték (jelölővonal) */
  plan?: number | null;
  /** jövőbeli / becsült érték (halványabb, szaggatott keret) */
  future?: boolean;
  note?: string;
}

export function DivergingBars({
  title,
  points,
  height = 150,
  unit = 'Ft',
  markerLabel = 'terv',
}: {
  title: string;
  points: BarPoint[];
  height?: number;
  unit?: string;
  markerLabel?: string;
}) {
  const [hi, setHi] = useState<number | null>(null);
  const max = Math.max(1, ...points.map((p) => Math.max(Math.abs(p.v), Math.abs(p.plan ?? 0))));
  // nullavonal: ha csak pozitív (vagy csak negatív) érték van, a teljes magasságot használja
  const hasNeg = points.some((p) => p.v < 0 || (p.plan ?? 0) < 0);
  const hasPos = points.some((p) => p.v > 0 || (p.plan ?? 0) > 0);
  const z = hasNeg && hasPos ? height / 2 : hasNeg ? 16 : height - 2;
  const span = (hasNeg && hasPos ? height / 2 : height - 18) - 2;
  const y = (v: number) => (Math.abs(v) / max) * span;
  const shown = hi !== null ? points[hi] : null;
  // feliratok csak a szélsőértékeken (és a kiválasztotton)
  const iMax = points.reduce((b, p, i) => (p.v > points[b].v ? i : b), 0);
  const iMin = points.reduce((b, p, i) => (p.v < points[b].v ? i : b), 0);
  return (
    <div style={{ ...card, padding: '12px 14px', display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' }}>
        <b style={{ font: `700 14px ${FONT_H}`, color: C.navy }}>{title}</b>
        <span style={{ font: `600 12.5px ${FONT}`, color: C.ink, fontVariantNumeric: 'tabular-nums' }}>
          {shown ? (
            <>
              {shown.ym.replace('-', '. ')}.:{' '}
              <b style={{ color: shown.v < 0 ? '#B04A3C' : POS }}>
                {(shown.v > 0 ? '+' : shown.v < 0 ? '−' : '') + fmt(Math.abs(shown.v))} {unit}
              </b>
              {shown.plan != null ? (
                <span style={{ color: C.muted }}>
                  {' '}
                  · {markerLabel} {fmt(shown.plan)}
                </span>
              ) : null}
              {shown.note ? <span style={{ color: C.muted }}> · {shown.note}</span> : null}
            </>
          ) : (
            <span style={{ color: C.muted }}>koppints egy hónapra</span>
          )}
        </span>
      </div>
      <div style={{ position: 'relative', height, display: 'flex', gap: 2 }} onMouseLeave={() => setHi(null)}>
        <div style={{ position: 'absolute', left: 0, right: 0, top: z, borderTop: `1px solid ${C.line2}` }} />
        {points.map((p, i) => {
          const h = Math.max(p.v ? 3 : 0, y(p.v));
          const pos = p.v >= 0;
          const col = pos ? POS : NEG;
          const label = (i === iMax && p.v > 0) || (i === iMin && p.v < 0) || i === hi;
          return (
            <div
              key={p.ym}
              onMouseEnter={() => setHi(i)}
              onClick={() => setHi(hi === i ? null : i)}
              style={{ flex: 1, position: 'relative', cursor: 'pointer', minWidth: 0 }}
            >
              <div
                style={{
                  position: 'absolute',
                  left: '50%',
                  transform: 'translateX(-50%)',
                  width: '78%',
                  maxWidth: 24,
                  height: h,
                  top: pos ? z - h : z + 1,
                  borderRadius: pos ? '4px 4px 0 0' : '0 0 4px 4px',
                  background: p.future ? 'transparent' : col,
                  border: p.future ? `1.5px dashed ${col}` : 0,
                  opacity: hi === null || hi === i ? 1 : 0.55,
                }}
              />
              {p.plan != null && (
                <div
                  title={markerLabel}
                  style={{
                    position: 'absolute',
                    left: '8%',
                    right: '8%',
                    top: z - (p.plan >= 0 ? y(p.plan) : -y(p.plan)) - 1,
                    borderTop: `2px solid ${C.navy}`,
                  }}
                />
              )}
              {label && p.v !== 0 && (
                <span
                  style={{
                    position: 'absolute',
                    left: '50%',
                    transform: 'translateX(-50%)',
                    top: pos ? Math.max(0, z - h - 15) : Math.min(height - 13, z + h + 2),
                    font: `700 10.5px ${FONT}`,
                    color: C.ink,
                    whiteSpace: 'nowrap',
                    background: 'rgba(255,255,255,.85)',
                    borderRadius: 4,
                    padding: '0 2px',
                  }}
                >
                  {(p.v > 0 ? '+' : '−') + fmtK(Math.abs(p.v))}
                </span>
              )}
            </div>
          );
        })}
      </div>
      <div style={{ display: 'flex', gap: 2 }}>
        {points.map((p, i) => (
          <span
            key={p.ym}
            style={{ flex: 1, minWidth: 0, textAlign: 'center', font: `500 10px ${FONT}`, color: i === hi ? C.navy : C.muted, overflow: 'hidden' }}
          >
            {points.length <= 13 || i % 3 === 0 ? monthLabel(p.ym).replace('.', '').slice(0, 3) : ''}
          </span>
        ))}
      </div>
      <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', font: `500 11.5px ${FONT}`, color: C.muted }}>
        <span>
          <i style={{ display: 'inline-block', width: 10, height: 10, borderRadius: 2, background: POS, marginRight: 5, verticalAlign: -1 }} />
          plusz
        </span>
        <span>
          <i style={{ display: 'inline-block', width: 10, height: 10, borderRadius: 2, background: NEG, marginRight: 5, verticalAlign: -1 }} />
          mínusz
        </span>
        {points.some((p) => p.plan != null) && (
          <span>
            <i style={{ display: 'inline-block', width: 14, borderTop: `2px solid ${C.navy}`, marginRight: 5, verticalAlign: 3 }} />
            {markerLabel}
          </span>
        )}
        {points.some((p) => p.future) && (
          <span>
            <i
              style={{ display: 'inline-block', width: 10, height: 10, borderRadius: 2, border: `1.5px dashed ${C.muted}`, marginRight: 5, verticalAlign: -1 }}
            />
            várható
          </span>
        )}
      </div>
    </div>
  );
}
