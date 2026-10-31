// Design tokenek (a 360 Marketing Cashflow designból) és apró közös komponensek.
import { useEffect, useId, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { parseWholeForint } from '../../shared/amount';
import { displayGroup } from '../../shared/categories';
import { fmt, type Index } from '../../shared/model';
import { VAT_RATE } from '../../shared/vat';

/*
 * Design tokenek – „Banki főkönyv” arculat: mélykék-grafit alap, meleg papírfelületek, vékony vonalak árnyék helyett.
 * Állapotszínek: bevétel = mélyzöld (inc), kiadás = grafit (ink), lejárt = téglavörös (neg), ajánlat = okker (offer).
 * Minden szín legalább 4.5:1 kontrasztú a saját hátterén (a muted2 / blue2 csak sötét felületen).
 */
export const C = {
  navy: '#14233A', // oldalsáv, sötét kiemelés
  navy2: '#1C2E47',
  navy3: '#2A3F5C',
  blue: '#1F4E79', // elsődleges művelet, fókusz
  blue2: '#A9C8E8', // akcentus sötét felületen
  blueDark: '#1F4E79', // hivatkozás, pozitív kiemelés
  ink: '#1D2430', // szöveg, kiadás
  muted: '#55606D',
  muted2: '#AFBCCB', // halvány szöveg sötét felületen
  faint: '#6E7682', // nulla / üres érték (4.5:1 a papíron)
  line: '#E2DED5',
  line2: '#CCC7BB',
  line3: '#EEEBE4',
  bg: '#F5F3EE', // papír háttér
  bg2: '#E8EEF4', // kijelölt / kiemelt sor
  bg3: '#FAF9F6',
  neg: '#A3392A', // lejárt, negatív
  negLight: '#F0B4A9',
  negBg: '#FAEDE9',
  inc: '#1D6A46', // bevétel
  incBg: '#E7F2EC',
  offer: '#8A5A10', // ajánlat (nem biztos)
  offerBg: '#FBF2DF',
  white: '#fff',
};

export const FONT_H = "'Source Serif 4', Georgia, 'Times New Roman', serif";
export const FONT = "Inter, system-ui, -apple-system, 'Segoe UI', sans-serif";

/** térköz-skála (px) */
export const S = { xs: 4, sm: 8, md: 12, lg: 16, xl: 24, xxl: 32, xxxl: 48 } as const;
/** betűméret-skála (px): címke · apró · törzs · kiemelt · alcím · cím · oldalcím · nagy szám */
export const FS = { label: 11, xs: 12, sm: 13, md: 14, lg: 16, xl: 20, xxl: 28, num: 24 } as const;
/** sarokkerekítés */
export const R = { sm: 4, md: 6, lg: 8, pill: 999 } as const;
/** árnyékok: a felületeket vonal választja el; árnyék csak a lebegő elemeken */
export const SHADOW = { none: 'none', card: '0 1px 0 rgba(20,35,58,.04)', pop: '0 8px 24px rgba(20,35,58,.16), 0 1px 3px rgba(20,35,58,.08)' } as const;

export const eyebrow: CSSProperties = { font: `600 ${FS.label}px ${FONT}`, letterSpacing: '.1em', textTransform: 'uppercase', color: C.muted };
export const card: CSSProperties = { background: '#fff', border: `1px solid ${C.line}`, borderRadius: R.lg, boxShadow: SHADOW.card };

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
    borderRadius: R.md,
    padding: props.small ? `${S.xs + 2}px ${S.md}px` : `${S.sm + 1}px ${S.lg}px`,
    font: `600 ${props.small ? FS.xs : FS.sm}px ${FONT}`,
    cursor: props.disabled ? 'not-allowed' : 'pointer',
    whiteSpace: 'nowrap',
  };
  const kinds: Record<string, CSSProperties> = {
    primary: { background: C.blue, color: '#fff' },
    dark: { background: C.navy, color: '#fff' },
    ghost: { background: '#fff', color: C.navy, border: `1px solid ${C.line2}` },
    light: { background: C.bg2, color: C.blueDark },
    danger: { background: '#fff', color: C.neg, border: `1px solid ${C.line2}` },
  };
  return (
    <button
      type={props.type || 'button'}
      title={props.title}
      className={'hov-' + k}
      disabled={props.disabled}
      aria-disabled={props.disabled || undefined}
      onClick={props.onClick}
      style={{ ...base, ...kinds[k], ...props.style }}
    >
      {props.children}
    </button>
  );
}

export function Seg<T extends string | number>(props: { value: T; options: [T, string][]; onChange: (v: T) => void; full?: boolean; small?: boolean }) {
  return (
    <div
      role="group"
      style={{ display: 'flex', background: C.bg, border: `1px solid ${C.line}`, borderRadius: R.lg, padding: 3, gap: 2, flex: props.full ? 1 : undefined }}
    >
      {props.options.map(([v, l]) => (
        <button
          key={String(v)}
          type="button"
          aria-pressed={props.value === v}
          className="seg-btn"
          onClick={() => props.onChange(v)}
          style={{
            flex: props.full ? 1 : undefined,
            border: 0,
            borderRadius: R.md,
            padding: props.small ? `${S.xs + 1}px ${S.md - 1}px` : `${S.xs + 3}px ${S.md + 2}px`,
            font: `600 ${props.small ? FS.xs : FS.sm}px ${FONT}`,
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
      aria-pressed={props.active}
      onClick={props.onClick}
      style={{
        border: `1px solid ${props.active ? C.blue : C.line2}`,
        borderRadius: R.pill,
        padding: `${S.xs + 2}px ${S.md}px`,
        font: `600 ${FS.xs}px ${FONT}`,
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
  borderRadius: R.md,
  padding: `0 ${S.md}px`,
  font: `500 ${FS.md}px ${FONT}`,
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
        borderRadius: R.lg,
        padding: '12px 14px 12px 18px',
        display: 'flex',
        gap: 14,
        alignItems: 'center',
        boxShadow: SHADOW.pop,
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

/** Az oldal (alkalmazás) rögzítése felugró ablak alatt; egymásba nyíló ablakoknál csak az első rögzít, az utolsó old fel. */
let pageLocks = 0;
let savedY = 0;
function lockPage(): () => void {
  const root = typeof document !== 'undefined' ? document.getElementById('root') : null;
  if (!root) return () => {};
  if (pageLocks++ === 0) {
    savedY = window.scrollY;
    // a látható rész marad (a gyökér saját görgetése = az eddigi oldalgörgetés)
    Object.assign(root.style, { position: 'fixed', top: '0', left: '0', right: '0', overflow: 'hidden', height: '100vh' });
    root.scrollTop = savedY;
    window.scrollTo({ top: 0 });
  }
  return () => {
    if (--pageLocks > 0) return;
    Object.assign(root.style, { position: '', top: '', left: '', right: '', overflow: '', height: '' });
    window.scrollTo({ top: savedY });
  };
}

export function Modal(props: { onClose: () => void; children: ReactNode; width?: number; title?: ReactNode; label?: string }) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const close = useRef(props.onClose);
  close.current = props.onClose;
  // a felugró ablak a dokumentumban van, a mögötte lévő oldal közben rögzítve (nem görget, nem nyúlik) – így a görgetés
  // és a görgetős képernyőkép / felvétel csak a felugró ablakot veszi, elejétől a végéig
  const top = 0;
  useEffect(() => {
    const dialog = ref.current!;
    const previous = document.activeElement as HTMLElement | null;
    const unlock = lockPage();
    dialog.show();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !e.defaultPrevented) {
        e.preventDefault();
        close.current();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      dialog.close();
      unlock();
      if (previous?.isConnected) previous.focus({ preventScroll: true });
    };
  }, []);
  return createPortal(
    <>
      <div aria-hidden style={{ position: 'fixed', inset: 0, background: 'rgba(20,35,58,.42)', zIndex: 900 }} onClick={() => close.current()} />
      <dialog
        ref={ref}
        aria-modal="true"
        aria-labelledby={props.title ? titleId : undefined}
        aria-label={props.title ? undefined : props.label || 'Szerkesztőablak'}
        onCancel={(e) => {
          e.preventDefault();
          close.current();
        }}
        onClick={(e) => {
          if (e.target === e.currentTarget) close.current();
        }}
        style={{
          position: 'absolute',
          top,
          left: 0,
          zIndex: 901,
          border: 0,
          padding: '1px 0 7vh',
          background: 'transparent',
          color: 'inherit',
          width: '100%',
          maxWidth: '100%',
          minHeight: '100vh',
          margin: 0,
        }}
      >
        <div
          style={{
            width: props.width || 640,
            maxWidth: 'calc(100% - 32px)',
            margin: '7vh auto',
            background: '#fff',
            borderRadius: 20,
            boxShadow: '0 2px 4px rgba(0,32,64,.06),0 24px 48px rgba(0,32,64,.2)',
            overflow: 'hidden',
          }}
        >
          {props.title && (
            <div id={titleId} style={{ padding: '20px 24px 0', font: `700 18px ${FONT_H}`, color: C.navy }}>
              {props.title}
            </div>
          )}
          {props.children}
        </div>
      </dialog>
    </>,
    document.body,
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

/** Pontos időpont (Budapest): „10. 22. 10:15”. */
export const dateTime = (ms: number | string) =>
  new Date(Number(ms)).toLocaleString('hu-HU', { timeZone: 'Europe/Budapest', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });

/** Pontos időpont és mennyi ideje: „10. 22. 10:15 (5 perce)”. */
export const stamp = (ms: number | string | null | undefined) => (ms ? `${dateTime(ms)} (${relTime(ms)})` : 'még nem');

export const shortDate = (d: string) => `${d.slice(5, 7)}.${d.slice(8, 10)}.`;

/** Dátum mező, ami mindig év. hó. nap sorrendben látszik; koppintásra a rendszer saját dátumválasztója nyílik. */
export { DateField } from './DatePicker';

/** Szinkron gomb: futás közben forgó jel és „Szinkronizálás…” felirat, a gomb addig nem nyomható újra. */
export function SyncPill({
  label,
  onRun,
  style,
  kind,
}: {
  label: string;
  onRun: () => Promise<unknown>;
  style?: CSSProperties;
  kind?: 'primary' | 'ghost' | 'light';
}) {
  const [busy, setBusy] = useState(false);
  return (
    <Pill
      kind={kind}
      style={{ ...style, opacity: busy ? 0.85 : 1, cursor: busy ? 'progress' : 'pointer' }}
      disabled={busy}
      onClick={async () => {
        if (busy) return;
        setBusy(true);
        try {
          await onRun();
        } finally {
          setBusy(false);
        }
      }}
    >
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
        {busy && (
          <span
            aria-hidden
            style={{
              display: 'inline-block',
              width: 14,
              height: 14,
              boxSizing: 'border-box',
              borderRadius: 999,
              border: '2px solid currentColor',
              borderTopColor: 'transparent',
              animation: 'spin .8s linear infinite',
            }}
          />
        )}
        {busy ? 'Szinkronizálás…' : label}
      </span>
    </Pill>
  );
}

/**
 * „nettó” jelölő egy összegmező mellé: bejelölve a beírt számot ÁFÁ-val felszorozza (bruttó lesz belőle), kivéve visszaállítja.
 * A program mindenhol bruttóval számol – a mező értéke mindig a bruttó. Ha bejelölés után átírod az összeget, a jelölő kikapcsol.
 */
export function NetBox({ value, onChange, small }: { value: string | number; onChange: (gross: string) => void; small?: boolean }) {
  const cur = parseWholeForint(value) || 0;
  const [st, setSt] = useState<{ net: number; gross: number } | null>(null);
  const on = !!st && st.gross === cur;
  const toggle = () => {
    if (on) {
      onChange(String(st!.net));
      setSt(null);
    } else if (cur) {
      const gross = Math.round(cur * (1 + VAT_RATE));
      setSt({ net: cur, gross });
      onChange(String(gross));
    }
  };
  return (
    <label
      // a fókusz az összegmezőben marad (a kattintás nem ment előre a nettó összeggel)
      onMouseDown={(e) => e.preventDefault()}
      title="A beírt összeg nettó: a program hozzáadja a 27% ÁFÁ-t (mindenhol bruttóval számol)"
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 5,
        cursor: cur ? 'pointer' : 'default',
        font: `600 ${small ? 11.5 : 12.5}px ${FONT}`,
        color: on ? C.blueDark : C.muted,
        whiteSpace: 'nowrap',
      }}
    >
      <input
        type="checkbox"
        checked={on}
        onChange={toggle}
        disabled={!cur && !on}
        style={{ width: small ? 14 : 16, height: small ? 14 : 16, cursor: 'inherit' }}
      />
      {on ? `nettó ${fmt(st!.net)} + ÁFA` : 'nettó'}
    </label>
  );
}

/** Törölt (kukába tett) tételek mutatása – közös, megjegyzett beállítás minden nézetben (alapból ki). */
export function useShowDeleted(): [boolean, (v: boolean) => void] {
  const read = () => {
    try {
      return localStorage.getItem('cf_show_deleted') === '1';
    } catch {
      return false;
    }
  };
  const [v, setV] = useState(read);
  useEffect(() => {
    const on = () => setV(read());
    window.addEventListener('cf-show-deleted', on);
    return () => window.removeEventListener('cf-show-deleted', on);
  }, []);
  const set = (n: boolean) => {
    try {
      localStorage.setItem('cf_show_deleted', n ? '1' : '0');
    } catch {}
    setV(n);
    window.dispatchEvent(new Event('cf-show-deleted'));
  };
  return [v, set];
}

/** „Töröltek mutatása” jelölőnégyzet */
export function ShowDeletedToggle({ count }: { count?: number }) {
  const [v, set] = useShowDeleted();
  return (
    <label
      style={{ display: 'inline-flex', alignItems: 'center', gap: 6, font: `600 12.5px ${FONT}`, color: C.muted, cursor: 'pointer', whiteSpace: 'nowrap' }}
    >
      <input type="checkbox" checked={v} onChange={(e) => set(e.target.checked)} style={{ width: 16, height: 16, accentColor: C.blue }} />
      Töröltek mutatása{count ? ` (${count})` : ''}
    </label>
  );
}
