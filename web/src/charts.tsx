// Egyszerű, animált SVG-grafikonok (vonal, oszlop, vízszintes sáv, tölcsér) – egy tengely, vékony jelölők,
// jelmagyarázat 2+ sorozatnál, egérrel kiolvasható érték, mozgáscsökkentésnél animáció nélkül (styles.css).
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { fmt } from '../../shared/model';
import { C, FONT } from './ui';

/** validált kategória-paletta (a dataviz ellenőrzőn átment), rögzített sorrendben */
export const SERIES = ['#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4', '#008300', '#6250d6', '#e34948'];
export const GOOD = '#1D6A46';
export const BAD = '#A3392A';

/** a tároló tényleges szélessége (a betűméret így minden kártyán azonos marad) */
function useWidth(def = 720): [React.RefObject<HTMLDivElement>, number] {
  const ref = useRef<HTMLDivElement>(null);
  const [w, setW] = useState(def);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver((e) => setW(Math.max(280, Math.round(e[0].contentRect.width))));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, w];
}

export const short = (v: number) => {
  const a = Math.abs(v);
  const s = a >= 1e6 ? (a / 1e6).toLocaleString('hu-HU', { maximumFractionDigits: 1 }) + ' M' : a >= 1e3 ? Math.round(a / 1e3) + ' e' : String(Math.round(a));
  return (v < 0 ? '−' : '') + s;
};

function niceTicks(min: number, max: number, n = 5, integer = false): number[] {
  if (min === max) max = min + 1;
  const span = max - min;
  const step0 = span / n;
  const mag = Math.pow(10, Math.floor(Math.log10(step0)));
  let step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => span / s <= n) || 10 * mag;
  if (integer) step = Math.max(1, Math.ceil(step));
  const out: number[] = [];
  const hi = Math.ceil(max / step - 1e-9) * step;
  for (let v = Math.floor(min / step) * step; v <= hi + step * 0.001; v += step) out.push(Math.round(v * 1000) / 1000);
  return out;
}

const lastIdx = (vals: (number | null)[]) => {
  for (let i = vals.length - 1; i >= 0; i--) if (vals[i] !== null) return i;
  return 0;
};

export function Legend({ items }: { items: { label: string; color: string; dashed?: boolean }[] }) {
  return (
    <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', font: `500 12.5px ${FONT}`, color: C.ink }}>
      {items.map((i) => (
        <span key={i.label} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <svg width="18" height="10" aria-hidden="true">
            <line x1="1" y1="5" x2="17" y2="5" stroke={i.color} strokeWidth="3" strokeLinecap="round" strokeDasharray={i.dashed ? '4 3' : undefined} />
          </svg>
          {i.label}
        </span>
      ))}
    </div>
  );
}

function Tip({ x, w, children }: { x: number; w: number; children: ReactNode }) {
  const left = Math.min(Math.max(x - 90, 0), Math.max(0, w - 200));
  return (
    <div
      role="status"
      style={{
        position: 'absolute',
        top: 4,
        left,
        width: 200,
        pointerEvents: 'none',
        background: '#fff',
        border: `1px solid ${C.line}`,
        borderRadius: 8,
        boxShadow: '0 8px 24px rgba(20,35,58,.16)',
        padding: '8px 10px',
        font: `400 12.5px/1.5 ${FONT}`,
        color: C.ink,
        zIndex: 5,
      }}
    >
      {children}
    </div>
  );
}

export interface LineSeries {
  label: string;
  color: string;
  values: (number | null)[];
  dashed?: boolean;
  area?: boolean;
}

/** vonaldiagram: hiányzó érték (null) = szakadás; crosshair + tooltip; opcionális függőleges jelölő (pl. „ma”) */
export function LineChart({
  labels,
  series,
  height = 240,
  marker,
  zero = true,
}: {
  labels: string[];
  series: LineSeries[];
  height?: number;
  marker?: number;
  zero?: boolean;
}) {
  const [ref, W] = useWidth();
  const [hover, setHover] = useState<number | null>(null);
  const H = height,
    L = 56,
    R = 12,
    T = 10,
    B = 26;
  const all = series.flatMap((s) => s.values.filter((v): v is number => v !== null));
  const ticks = niceTicks(Math.min(zero ? 0 : Infinity, ...all), Math.max(zero ? 0 : -Infinity, ...all));
  const y0 = ticks[0],
    y1 = ticks[ticks.length - 1];
  const x = (i: number) => L + (labels.length < 2 ? 0 : (i * (W - L - R)) / (labels.length - 1));
  const y = (v: number) => T + (H - T - B) * (1 - (v - y0) / (y1 - y0 || 1));
  const path = (vals: (number | null)[]) => {
    let d = '';
    let pen = false;
    vals.forEach((v, i) => {
      if (v === null) return (pen = false);
      d += `${pen ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`;
      pen = true;
    });
    return d;
  };
  const onMove = (e: React.MouseEvent) => {
    const r = ref.current!.getBoundingClientRect();
    const px = ((e.clientX - r.left) / r.width) * W;
    const i = Math.round(((px - L) / (W - L - R)) * (labels.length - 1));
    setHover(Math.max(0, Math.min(labels.length - 1, i)));
  };
  return (
    <div ref={ref} style={{ position: 'relative' }} onMouseMove={onMove} onMouseLeave={() => setHover(null)}>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        width={W}
        height={H}
        style={{ display: 'block', maxWidth: '100%' }}
        role="img"
        aria-label={series.map((s) => s.label).join(', ')}
      >
        {ticks.map((t) => (
          <g key={t}>
            <line x1={L} x2={W - R} y1={y(t)} y2={y(t)} stroke={t === 0 ? '#9aa1aa' : C.line3} strokeWidth={t === 0 ? 1 : 1} />
            <text x={L - 8} y={y(t) + 4} textAnchor="end" style={{ font: `400 11px ${FONT}`, fill: C.muted }}>
              {short(t)}
            </text>
          </g>
        ))}
        {labels.map((l, i) =>
          labels.length <= 13 || i % 2 === 0 ? (
            <text key={i} x={x(i)} y={H - 8} textAnchor="middle" style={{ font: `400 11px ${FONT}`, fill: C.muted }}>
              {l}
            </text>
          ) : null,
        )}
        {marker !== undefined && <line x1={x(marker)} x2={x(marker)} y1={T} y2={H - B} stroke={C.navy} strokeDasharray="3 4" strokeWidth="1" opacity=".5" />}
        {series.map((s, si) =>
          s.area ? (
            <path
              key={'a' + si}
              className="cf-area"
              d={`${path(s.values)}L${x(lastIdx(s.values))},${y(Math.max(0, y0))}L${x(s.values.findIndex((v) => v !== null))},${y(Math.max(0, y0))}Z`}
              fill={s.color}
              fillOpacity=".12"
            />
          ) : null,
        )}
        {series.map((s, si) => (
          <path
            key={si}
            className={s.dashed ? 'cf-area' : 'cf-line'}
            pathLength={s.dashed ? undefined : 1}
            d={path(s.values)}
            fill="none"
            stroke={s.color}
            strokeWidth="2.5"
            strokeLinejoin="round"
            strokeLinecap="round"
            style={{ animationDelay: si * 150 + 'ms' }}
            strokeDasharray={s.dashed ? '7 5' : undefined}
          />
        ))}
        {hover !== null && (
          <g>
            <line x1={x(hover)} x2={x(hover)} y1={T} y2={H - B} stroke={C.navy} strokeWidth="1" opacity=".35" />
            {series.map((s, si) =>
              s.values[hover] !== null ? <circle key={si} cx={x(hover)} cy={y(s.values[hover]!)} r="4.5" fill={s.color} stroke="#fff" strokeWidth="2" /> : null,
            )}
          </g>
        )}
      </svg>
      {hover !== null && (
        <Tip x={(x(hover) / W) * (ref.current?.clientWidth || W)} w={ref.current?.clientWidth || W}>
          <b style={{ color: C.navy }}>{labels[hover]}</b>
          {series.map((s) => (
            <div key={s.label} style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
              <span>
                <span style={{ display: 'inline-block', width: 8, height: 8, borderRadius: 2, background: s.color, marginRight: 6 }} />
                {s.label}
              </span>
              <b style={{ fontVariantNumeric: 'tabular-nums' }}>{s.values[hover] === null ? 'nincs adat' : fmt(s.values[hover]!)}</b>
            </div>
          ))}
        </Tip>
      )}
    </div>
  );
}

export interface BarSeries {
  label: string;
  color: string;
  values: number[];
}

/** oszlopdiagram: csoportos vagy halmozott, pozitív és negatív értékkel; opcionális vonal (pl. nettó); tooltip oszlopcsoportonként */
export function BarChart({
  labels,
  series,
  stacked,
  line,
  height = 240,
  hatch,
  integer,
}: {
  labels: string[];
  series: BarSeries[];
  stacked?: boolean;
  line?: { label: string; color: string; values: number[] };
  height?: number;
  /** ezek az oszlopok (index) terv / előrejelzés – halványabbak */
  hatch?: (i: number) => boolean;
  /** egész számú tengely (pl. darabszám) */
  integer?: boolean;
}) {
  const [ref, W] = useWidth();
  const [hover, setHover] = useState<number | null>(null);
  const H = height,
    L = 56,
    R = 12,
    T = 10,
    B = 26;
  const ext = useMemo(() => {
    let lo = 0,
      hi = 0;
    labels.forEach((_, i) => {
      if (stacked) {
        const pos = series.reduce((s, x) => s + Math.max(0, x.values[i] || 0), 0);
        const neg = series.reduce((s, x) => s + Math.min(0, x.values[i] || 0), 0);
        hi = Math.max(hi, pos);
        lo = Math.min(lo, neg);
      } else
        series.forEach((x) => {
          hi = Math.max(hi, x.values[i] || 0);
          lo = Math.min(lo, x.values[i] || 0);
        });
      if (line) {
        hi = Math.max(hi, line.values[i] || 0);
        lo = Math.min(lo, line.values[i] || 0);
      }
    });
    return [lo, hi];
  }, [labels, series, stacked, line]);
  const ticks = niceTicks(ext[0], ext[1], 5, integer);
  const y0 = ticks[0],
    y1 = ticks[ticks.length - 1];
  const y = (v: number) => T + (H - T - B) * (1 - (v - y0) / (y1 - y0 || 1));
  const band = (W - L - R) / labels.length;
  const groupW = Math.min(band * 0.7, 56 * (stacked ? 1 : series.length));
  const barW = stacked ? groupW : groupW / series.length;
  const bars: ReactNode[] = [];
  labels.forEach((_, i) => {
    let pos = 0,
      neg = 0;
    series.forEach((s, si) => {
      const v = s.values[i] || 0;
      if (!v) return;
      const x0 = L + i * band + (band - groupW) / 2 + (stacked ? 0 : si * barW);
      let top: number, bot: number;
      if (stacked) {
        if (v >= 0) {
          top = y(pos + v);
          bot = y(pos);
          pos += v;
        } else {
          top = y(neg);
          bot = y(neg + v);
          neg += v;
        }
      } else {
        top = y(Math.max(0, v));
        bot = y(Math.min(0, v));
      }
      const h = Math.max(1, bot - top - (stacked ? 1 : 0));
      bars.push(
        <rect
          key={`${i}-${si}`}
          className="cf-bar"
          x={x0 + (stacked ? 0 : 1)}
          y={top}
          width={Math.max(2, barW - 2)}
          height={h}
          rx={Math.min(4, barW / 3)}
          fill={s.color}
          opacity={hatch?.(i) ? 0.45 : hover === null || hover === i ? 1 : 0.55}
          style={{ transformOrigin: v >= 0 ? 'bottom' : 'top', animationDelay: i * 35 + si * 60 + 'ms' }}
        />,
      );
    });
  });
  const onMove = (e: React.MouseEvent) => {
    const r = ref.current!.getBoundingClientRect();
    const px = ((e.clientX - r.left) / r.width) * W;
    const i = Math.floor((px - L) / band);
    setHover(i >= 0 && i < labels.length ? i : null);
  };
  return (
    <div ref={ref} style={{ position: 'relative' }} onMouseMove={onMove} onMouseLeave={() => setHover(null)}>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        width={W}
        height={H}
        style={{ display: 'block', maxWidth: '100%' }}
        role="img"
        aria-label={series.map((s) => s.label).join(', ')}
      >
        {ticks.map((t) => (
          <g key={t}>
            <line x1={L} x2={W - R} y1={y(t)} y2={y(t)} stroke={t === 0 ? '#9aa1aa' : C.line3} />
            <text x={L - 8} y={y(t) + 4} textAnchor="end" style={{ font: `400 11px ${FONT}`, fill: C.muted }}>
              {short(t)}
            </text>
          </g>
        ))}
        {bars}
        {line && (
          <path
            className="cf-line"
            pathLength={1}
            d={line.values.map((v, i) => `${i ? 'L' : 'M'}${(L + i * band + band / 2).toFixed(1)},${y(v).toFixed(1)}`).join('')}
            fill="none"
            stroke={line.color}
            strokeWidth="2.5"
            strokeLinejoin="round"
            style={{ animationDelay: '500ms' }}
          />
        )}
        {line?.values.map((v, i) => (
          <circle key={i} cx={L + i * band + band / 2} cy={y(v)} r="3.5" fill={line.color} stroke="#fff" strokeWidth="1.5" className="cf-area" />
        ))}
        {labels.map((l, i) =>
          labels.length <= 13 || i % 2 === 0 ? (
            <text key={i} x={L + i * band + band / 2} y={H - 8} textAnchor="middle" style={{ font: `400 11px ${FONT}`, fill: C.muted }}>
              {l}
            </text>
          ) : null,
        )}
      </svg>
      {hover !== null && (
        <Tip x={((L + hover * band + band / 2) / W) * (ref.current?.clientWidth || W)} w={ref.current?.clientWidth || W}>
          <b style={{ color: C.navy }}>
            {labels[hover]}
            {hatch?.(hover) ? ' (terv)' : ''}
          </b>
          {series.map((s) => (
            <div key={s.label} style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
              <span>
                <span style={{ display: 'inline-block', width: 8, height: 8, borderRadius: 2, background: s.color, marginRight: 6 }} />
                {s.label}
              </span>
              <b style={{ fontVariantNumeric: 'tabular-nums' }}>{fmt(s.values[hover] || 0)}</b>
            </div>
          ))}
          {line && (
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, borderTop: `1px solid ${C.line3}`, marginTop: 4, paddingTop: 4 }}>
              <span>{line.label}</span>
              <b style={{ fontVariantNumeric: 'tabular-nums' }}>{fmt(line.values[hover] || 0)}</b>
            </div>
          )}
        </Tip>
      )}
    </div>
  );
}

/** vízszintes sávok (rangsor vagy eltérés): előjeles értéknél középvonal; opcionális küszöbvonal; címke és érték a sáv mellett */
export function HBars({
  rows,
  threshold,
  fmtV = (v) => fmt(v) + ' Ft',
  onClick,
}: {
  rows: { label: string; value: number; color?: string; note?: string }[];
  threshold?: { value: number; label: string };
  fmtV?: (v: number) => string;
  onClick?: (i: number) => void;
}) {
  // a leghosszabb sáv mellett is maradjon hely az értéknek
  const max = Math.max(1, ...rows.map((r) => Math.abs(r.value)), threshold?.value || 0) * (rows.some((r) => r.value < 0) ? 1.6 : 1.45);
  const signed = rows.some((r) => r.value < 0);
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6, position: 'relative' }}>
      {rows.map((r, i) => {
        const w = (Math.abs(r.value) / max) * (signed ? 50 : 100);
        return (
          <div
            key={r.label + i}
            onClick={onClick ? () => onClick(i) : undefined}
            role={onClick ? 'button' : undefined}
            title={`${r.label}: ${fmtV(r.value)}${r.note ? ' · ' + r.note : ''}`}
            style={{ display: 'grid', gridTemplateColumns: 'minmax(110px, 30%) 1fr', gap: 10, alignItems: 'center', cursor: onClick ? 'pointer' : 'default' }}
          >
            <span style={{ font: `500 13px ${FONT}`, color: C.ink, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.label}</span>
            <div style={{ position: 'relative', height: 22 }}>
              {signed && <span style={{ position: 'absolute', left: '50%', top: -2, bottom: -2, width: 1, background: '#9aa1aa' }} />}
              <span
                className="cf-hbar"
                style={{
                  position: 'absolute',
                  top: 3,
                  height: 16,
                  borderRadius: 4,
                  background: r.color || SERIES[0],
                  width: `${w}%`,
                  left: signed ? (r.value < 0 ? `${50 - w}%` : '50%') : 0,
                  transformOrigin: signed && r.value < 0 ? 'right center' : 'left center',
                  animationDelay: i * 45 + 'ms',
                }}
              />
              <span
                style={{
                  position: 'absolute',
                  top: 2,
                  font: `600 12px ${FONT}`,
                  color: C.ink,
                  fontVariantNumeric: 'tabular-nums',
                  whiteSpace: 'nowrap',
                  ...(signed ? (r.value < 0 ? { right: `${50 + w + 1}%` } : { left: `${50 + w + 1}%` }) : { left: `calc(${w}% + 6px)` }),
                }}
              >
                {fmtV(r.value)}
                {r.note ? <span style={{ fontWeight: 400, color: C.muted }}> · {r.note}</span> : null}
              </span>
            </div>
          </div>
        );
      })}
      {threshold && !signed && (
        <span
          title={threshold.label}
          style={{
            position: 'absolute',
            top: -4,
            bottom: -4,
            left: `calc(30% + 10px + (70% - 10px) * ${threshold.value / max})`,
            width: 0,
            borderLeft: `2px dashed ${BAD}`,
          }}
        />
      )}
    </div>
  );
}

/** tölcsér: lépcsőnként csökkenő sávok, darabszám és összeg, átváltási arány az előzőhöz */
export function Funnel({ steps }: { steps: { label: string; n: number; sum: number }[] }) {
  const max = Math.max(1, ...steps.map((s) => s.sum));
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      {steps.map((s, i) => {
        const w = Math.max(6, (s.sum / max) * 100);
        const conv = i > 0 && steps[i - 1].sum ? Math.round((s.sum / steps[i - 1].sum) * 100) : null;
        return (
          <div key={s.label} style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2 }}>
            <div
              className="cf-hbar"
              style={{
                width: `${w}%`,
                transformOrigin: 'center',
                height: 34,
                borderRadius: 6,
                background: SERIES[0],
                opacity: 1 - i * 0.16,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                color: '#fff',
                font: `700 13px ${FONT}`,
                animationDelay: i * 120 + 'ms',
                whiteSpace: 'nowrap',
                overflow: 'hidden',
              }}
            >
              {fmt(s.sum)} Ft
            </div>
            <span style={{ font: `500 12.5px ${FONT}`, color: C.ink }}>
              {s.label} · {s.n} db{conv !== null ? <span style={{ color: C.muted }}> · {conv}% az előzőből</span> : null}
            </span>
          </div>
        );
      })}
    </div>
  );
}
