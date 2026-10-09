// Mobil havi tétellista: szűrés (Tény / Terv / Ajánlat), a teljesült tételek összecsukva, terv + tény összevonva.
import { useState } from 'react';
import { fmt, monthLabel } from '../../shared/model';
import type { MonthRow } from '../../shared/monthrows';
import type { Entry } from '../../shared/types';
import { useStore } from './store';
import { C, FONT, FONT_H } from './ui';

export type RowFilter = { actual: boolean; plan: boolean; offer: boolean };
const FKEY = 'cf_month_filter_v1';

export function useRowFilter(): [RowFilter, (f: RowFilter) => void] {
  const [f, setF] = useState<RowFilter>(() => {
    try {
      const v = JSON.parse(localStorage.getItem(FKEY) || '');
      if (v && typeof v === 'object') return { actual: v.actual !== false, plan: v.plan !== false, offer: v.offer !== false };
    } catch {}
    return { actual: true, plan: true, offer: true };
  });
  const set = (n: RowFilter) => {
    setF(n);
    try {
      localStorage.setItem(FKEY, JSON.stringify(n));
    } catch {}
  };
  return [f, set];
}

export const rowVisible = (r: MonthRow, f: RowFilter) => (r.completed ? f.actual : r.kind === 'offer' ? f.offer : f.plan);

export function FilterChips({ f, onChange, counts }: { f: RowFilter; onChange: (f: RowFilter) => void; counts: Record<keyof RowFilter, number> }) {
  const chips: [keyof RowFilter, string][] = [
    ['actual', 'Tény'],
    ['plan', 'Terv'],
    ['offer', 'Ajánlat'],
  ];
  return (
    <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
      {chips.map(([k, l]) => (
        <button
          key={k}
          onClick={() => {
            const n = { ...f, [k]: !f[k] };
            if (!n.actual && !n.plan && !n.offer) return;
            onChange(n);
          }}
          style={{
            height: 34,
            borderRadius: 999,
            padding: '0 12px',
            border: `1.5px solid ${f[k] ? C.navy : C.line2}`,
            background: f[k] ? C.navy : '#fff',
            color: f[k] ? '#fff' : C.muted,
            font: `600 13px ${FONT}`,
          }}
        >
          {f[k] ? '✓ ' : ''}
          {l} <span style={{ opacity: 0.7 }}>{counts[k]}</span>
        </button>
      ))}
    </div>
  );
}

export function MonthList(props: {
  rows: MonthRow[];
  sign: number;
  m: string;
  selMode: boolean;
  sel: Record<string, boolean>;
  setSel: (f: (x: Record<string, boolean>) => Record<string, boolean>) => void;
  onOpenPlan: (e: Entry) => void;
  onDetail: (r: MonthRow) => void;
  onToggleDone: (e: Entry) => void;
}) {
  const { rows, sign, m } = props;
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const done = rows.filter((r) => r.completed);
  const rest = rows.filter((r) => !r.completed);
  const isOpen = !!open[m];
  const devN = done.filter((r) => r.dev).length;
  return (
    <>
      {done.length > 0 && (
        <button
          onClick={() => setOpen((x) => ({ ...x, [m]: !x[m] }))}
          style={{
            width: '100%',
            minHeight: 54,
            border: `1.5px solid ${devN ? C.negLight : C.line2}`,
            background: devN ? C.negBg : C.bg2,
            borderRadius: 14,
            padding: '10px 14px',
            display: 'flex',
            alignItems: 'center',
            gap: 10,
            textAlign: 'left',
          }}
        >
          <span style={{ font: `700 18px ${FONT}`, color: C.blueDark, width: 22 }}>{isOpen ? '▾' : '▸'}</span>
          <span style={{ flex: 1, display: 'flex', flexDirection: 'column' }}>
            <b style={{ font: `700 14.5px ${FONT}`, color: C.navy }}>✓ Teljesült · {done.length} tétel</b>
            <span style={{ font: `500 12px ${FONT}`, color: devN ? C.neg : C.muted }}>{devN ? `${devN} eltérés a tervtől` : 'kiszámlázva, kifizetve'}</span>
          </span>
          <b style={{ font: `700 15px ${FONT_H}`, color: C.blueDark, fontVariantNumeric: 'tabular-nums' }}>
            {fmt(done.reduce((a, r) => a + r.amount * sign, 0))}
          </b>
        </button>
      )}
      {isOpen && done.map((r) => <Row key={r.key} r={r} {...props} />)}
      {rest.map((r) => (
        <Row key={r.key} r={r} {...props} />
      ))}
    </>
  );
}

function Row(p: {
  r: MonthRow;
  sign: number;
  m: string;
  selMode: boolean;
  sel: Record<string, boolean>;
  setSel: (f: (x: Record<string, boolean>) => Record<string, boolean>) => void;
  onOpenPlan: (e: Entry) => void;
  onDetail: (r: MonthRow) => void;
  onToggleDone: (e: Entry) => void;
}) {
  const { ix, canEdit } = useStore();
  const { r, sign } = p;
  const planId = r.plan && !r.completed ? r.plan.id : null;
  const s = !!(planId && p.sel[planId]);
  const red = r.late || r.dev;
  const chip =
    r.kind === 'merged'
      ? 'Terv → Tény'
      : r.kind === 'actual'
        ? 'Tény'
        : r.kind === 'done'
          ? '✓ Kész'
          : r.kind === 'offer'
            ? 'Ajánlat'
            : r.plan?.source === 'billingo'
              ? 'Billingo'
              : 'Terv';
  const sub = r.dev
    ? `terv ${fmt(r.plan!.amount * sign)} → ${r.diff * sign > 0 ? '+' : '−'}${fmt(Math.abs(r.diff))}`
    : r.late
      ? 'lejárt'
      : r.kind === 'merged' && r.days
        ? `${Math.abs(r.days)} nap ${r.days > 0 ? 'késés' : 'előbb'}`
        : ix.leafById[r.leaf_id]?.label;
  return (
    <div
      onClick={() => {
        if (p.selMode) {
          if (planId) p.setSel((x) => ({ ...x, [planId]: !x[planId] }));
        } else if (r.completed) p.onDetail(r);
        else if (canEdit && r.plan) p.onOpenPlan(r.plan);
      }}
      style={{
        width: '100%',
        minHeight: 68,
        border: `1.5px solid ${s ? C.blue : red ? C.negLight : C.line}`,
        background: s ? C.bg2 : '#fff',
        borderRadius: 14,
        padding: '12px 14px',
        display: 'flex',
        alignItems: 'center',
        gap: 12,
        cursor: 'pointer',
      }}
    >
      {p.selMode && (
        <span
          style={{
            width: 24,
            height: 24,
            flex: 'none',
            borderRadius: 7,
            border: `2px solid ${!planId ? C.line : s ? C.blue : C.line2}`,
            background: s ? C.blue : '#fff',
            color: '#fff',
            display: 'grid',
            placeItems: 'center',
            font: `700 13px ${FONT}`,
          }}
        >
          {s ? '✓' : ''}
        </span>
      )}
      <span
        style={{
          width: 46,
          flex: 'none',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          lineHeight: 1.05,
          padding: '6px 0',
          borderRadius: 10,
          background: red ? C.negBg : r.completed ? C.bg2 : C.bg,
        }}
      >
        <b style={{ font: `800 19px ${FONT_H}`, color: red ? C.neg : r.completed ? C.blueDark : C.navy }}>{Number(r.date.slice(8))}</b>
        <span style={{ font: `600 10.5px ${FONT}`, color: red ? C.neg : r.completed ? C.blueDark : C.navy, textTransform: 'uppercase' }}>
          {monthLabel(r.date.slice(0, 7)).replace('.', '')}
        </span>
      </span>
      <span style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 5 }}>
        <span style={{ font: `600 15px ${FONT}`, color: C.navy, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
          {r.name || ix.leafById[r.leaf_id]?.label}
        </span>
        <span style={{ display: 'flex', flexWrap: 'wrap', gap: '4px 6px', alignItems: 'center' }}>
          <span
            style={{
              padding: '2px 8px',
              borderRadius: 999,
              background: r.completed ? '#fff' : r.kind === 'offer' ? '#FFF6DE' : C.bg2,
              border: r.completed ? `1px solid ${C.line2}` : 0,
              color: r.kind === 'offer' ? '#8A6D1C' : C.blueDark,
              font: `600 11px ${FONT}`,
              whiteSpace: 'nowrap',
            }}
          >
            {chip}
          </span>
          <span style={{ font: `600 12px ${FONT}`, color: red ? C.neg : C.muted, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
            {sub}
          </span>
        </span>
      </span>
      <span style={{ flex: 'none', display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 2 }}>
        <span
          style={{
            font: `700 15px ${FONT_H}`,
            color: red ? C.neg : r.completed ? C.blueDark : C.navy,
            fontVariantNumeric: 'tabular-nums',
            whiteSpace: 'nowrap',
          }}
        >
          {fmt(r.amount * sign)}
        </span>
        {r.completed ? (
          <span style={{ font: `600 11.5px ${FONT}`, color: C.blueDark }}>adatlap ›</span>
        ) : (
          !p.selMode &&
          canEdit &&
          r.plan && (
            <button
              onClick={(ev) => {
                ev.stopPropagation();
                p.onToggleDone(r.plan!);
              }}
              title="Kész"
              style={{
                width: 44,
                height: 36,
                margin: '-2px -8px -8px 0',
                border: 0,
                background: 'transparent',
                padding: 0,
                display: 'grid',
                placeItems: 'center',
              }}
            >
              <span style={{ width: 28, height: 28, borderRadius: 999, border: `2px solid ${C.muted2}`, background: '#fff' }} />
            </button>
          )
        )}
      </span>
    </div>
  );
}
