// Design tokenek (a 360 Marketing Cashflow designból) és apró közös komponensek.
import type { CSSProperties, ReactNode } from 'react';
import { displayGroup } from '../../shared/categories';
import type { Index } from '../../shared/model';

export const C = {
  navy: '#002040',
  navy2: '#0C2740',
  navy3: '#163350',
  blue: '#287FAA',
  blue2: '#3D9BD0',
  blueDark: '#1E6488',
  ink: '#1F2933',
  muted: '#5B6770',
  muted2: '#9DB2C6',
  faint: '#9AA6B0',
  line: '#E3E8EF',
  line2: '#CDD7E2',
  line3: '#EEF1F5',
  bg: '#F4F7FB',
  bg2: '#EAF2F8',
  bg3: '#FAFBFC',
  neg: '#B04A3C',
  negLight: '#FFB4A8',
  negBg: '#FBEDEA',
  white: '#fff',
};

export const FONT_H = 'Sora, sans-serif';
export const FONT = 'Inter, system-ui, sans-serif';

export const eyebrow: CSSProperties = { font: `600 11px ${FONT}`, letterSpacing: '.12em', textTransform: 'uppercase', color: C.muted };
export const card: CSSProperties = { background: '#fff', border: `1px solid ${C.line}`, borderRadius: 14, boxShadow: '0 1px 2px rgba(0,32,64,.05)' };

export function Pill(props: {
  children: ReactNode;
  onClick?: () => void;
  kind?: 'primary' | 'dark' | 'ghost' | 'light' | 'danger';
  small?: boolean;
  disabled?: boolean;
  style?: CSSProperties;
  title?: string;
  type?: 'button' | 'submit';
}) {
  const k = props.kind || 'ghost';
  const base: CSSProperties = {
    border: 0,
    borderRadius: 999,
    padding: props.small ? '7px 13px' : '10px 18px',
    font: `600 ${props.small ? 12.5 : 13.5}px ${FONT}`,
    cursor: props.disabled ? 'default' : 'pointer',
    whiteSpace: 'nowrap',
    opacity: props.disabled ? 0.55 : 1,
  };
  const kinds: Record<string, CSSProperties> = {
    primary: { background: C.blue, color: '#fff' },
    dark: { background: C.navy, color: '#fff' },
    ghost: { background: 'transparent', color: C.navy, border: `1.5px solid ${C.line2}` },
    light: { background: C.bg2, color: C.blueDark },
    danger: { background: 'transparent', color: C.neg, border: `1.5px solid ${C.line}` },
  };
  return (
    <button
      type={props.type || 'button'}
      title={props.title}
      className={'hov-' + k}
      disabled={props.disabled}
      onClick={props.onClick}
      style={{ ...base, ...kinds[k], ...props.style }}
    >
      {props.children}
    </button>
  );
}

export function Seg<T extends string | number>(props: { value: T; options: [T, string][]; onChange: (v: T) => void; full?: boolean; small?: boolean }) {
  return (
    <div style={{ display: 'flex', background: C.bg, border: `1px solid ${C.line}`, borderRadius: 999, padding: 3, gap: 2, flex: props.full ? 1 : undefined }}>
      {props.options.map(([v, l]) => (
        <button
          key={String(v)}
          type="button"
          onClick={() => props.onChange(v)}
          style={{
            flex: props.full ? 1 : undefined,
            border: 0,
            borderRadius: 999,
            padding: props.small ? '6px 11px' : '7px 14px',
            font: `600 ${props.small ? 12 : 13}px ${FONT}`,
            cursor: 'pointer',
            background: props.value === v ? C.navy : 'transparent',
            color: props.value === v ? '#fff' : C.muted,
            whiteSpace: 'nowrap',
          }}
        >
          {l}
        </button>
      ))}
    </div>
  );
}

export function Chip(props: { active?: boolean; children: ReactNode; onClick?: () => void; style?: CSSProperties; title?: string }) {
  return (
    <button
      type="button"
      title={props.title}
      onClick={props.onClick}
      style={{
        border: `1px solid ${props.active ? C.blue : C.line2}`,
        borderRadius: 999,
        padding: '6px 12px',
        font: `600 12.5px ${FONT}`,
        cursor: 'pointer',
        background: props.active ? C.blue : '#fff',
        color: props.active ? '#fff' : C.ink,
        whiteSpace: 'nowrap',
        ...props.style,
      }}
    >
      {props.children}
    </button>
  );
}

export const inputStyle: CSSProperties = {
  height: 38,
  border: `1px solid ${C.line2}`,
  borderRadius: 8,
  padding: '0 12px',
  font: `500 14px ${FONT}`,
  color: C.ink,
  background: '#fff',
  outlineColor: C.blue,
  minWidth: 0,
};

export function Field(props: { label: string; children: ReactNode; style?: CSSProperties }) {
  return (
    <label style={{ display: 'flex', flexDirection: 'column', gap: 6, ...props.style }}>
      <span style={eyebrow}>{props.label}</span>
      {props.children}
    </label>
  );
}

export function ToastView(props: { msg: string; undo?: () => void; error?: boolean; mobile?: boolean }) {
  return (
    <div
      role="status"
      style={{
        position: 'fixed',
        zIndex: 80,
        ...(props.mobile ? { left: 12, right: 12, top: 'calc(env(safe-area-inset-top) + 10px)' } : { left: 276, bottom: 22 }),
        background: props.mobile ? C.navy : '#fff',
        color: props.mobile ? '#fff' : C.ink,
        border: props.mobile ? 0 : `1px solid ${props.error ? C.neg : C.line}`,
        borderRadius: 14,
        padding: '12px 14px 12px 18px',
        display: 'flex',
        gap: 14,
        alignItems: 'center',
        boxShadow: '0 2px 4px rgba(0,32,64,.06),0 24px 48px rgba(0,32,64,.18)',
        maxWidth: props.mobile ? undefined : 560,
      }}
    >
      <span style={{ flex: 1, font: `500 13.5px ${FONT}`, color: props.error ? (props.mobile ? C.negLight : C.neg) : undefined }}>{props.msg}</span>
      {props.undo && (
        <button
          onClick={props.undo}
          style={{
            border: 0,
            background: props.mobile ? C.navy3 : C.bg2,
            color: props.mobile ? C.blue2 : C.blueDark,
            borderRadius: 999,
            padding: '7px 13px',
            font: `600 12.5px ${FONT}`,
            cursor: 'pointer',
          }}
        >
          Visszavonás
        </button>
      )}
    </div>
  );
}

export function Modal(props: { onClose: () => void; children: ReactNode; width?: number; title?: ReactNode }) {
  return (
    <div
      onClick={props.onClose}
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 60,
        background: 'rgba(0,32,64,.45)',
        display: 'flex',
        alignItems: 'flex-start',
        justifyContent: 'center',
        padding: '7vh 16px',
        overflow: 'auto',
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => e.key === 'Escape' && props.onClose()}
        style={{
          width: props.width || 640,
          maxWidth: '100%',
          background: '#fff',
          borderRadius: 20,
          boxShadow: '0 2px 4px rgba(0,32,64,.06),0 24px 48px rgba(0,32,64,.2)',
          overflow: 'hidden',
        }}
      >
        {props.title && <div style={{ padding: '20px 24px 0', font: `700 18px ${FONT_H}`, color: C.navy }}>{props.title}</div>}
        {props.children}
      </div>
    </div>
  );
}

export function leafOptions(ix: Index, section?: 'in' | 'out') {
  const out: { id: string; label: string; group: string; section: 'in' | 'out' }[] = [];
  for (const g of ix.groups) {
    if (section && g.section !== section) continue;
    for (const l of ix.leaves) if (l.group_id === g.id && !l.archived) out.push({ id: l.id, label: l.label, group: displayGroup(g.label), section: g.section });
  }
  return out;
}

export function LeafSelect(props: { ix: Index; value: string | null; onChange: (id: string) => void; section?: 'in' | 'out'; style?: CSSProperties }) {
  const opts = leafOptions(props.ix, props.section);
  const groups = [...new Set(opts.map((o) => (o.section === 'in' ? 'Bevétel · ' : 'Kiadás · ') + o.group))];
  return (
    <select value={props.value || ''} onChange={(e) => props.onChange(e.target.value)} style={{ ...inputStyle, ...props.style }}>
      <option value="" disabled>
        Válassz kategóriát…
      </option>
      {groups.map((g) => (
        <optgroup key={g} label={g}>
          {opts
            .filter((o) => (o.section === 'in' ? 'Bevétel · ' : 'Kiadás · ') + o.group === g)
            .map((o) => (
              <option key={o.id} value={o.id}>
                {o.label}
              </option>
            ))}
        </optgroup>
      ))}
    </select>
  );
}

export const relTime = (ms: number | string | null | undefined) => {
  if (!ms) return 'még nem';
  const d = Date.now() - Number(ms);
  if (d < 90_000) return 'épp most';
  if (d < 3600_000) return Math.round(d / 60_000) + ' perce';
  if (d < 86400_000) return Math.round(d / 3600_000) + ' órája';
  return Math.round(d / 86400_000) + ' napja';
};

export const shortDate = (d: string) => `${d.slice(5, 7)}.${d.slice(8, 10)}.`;

/** Dátum mező, ami mindig év. hó. nap sorrendben látszik; koppintásra a rendszer saját dátumválasztója nyílik. */
export { DateField } from './DatePicker';
