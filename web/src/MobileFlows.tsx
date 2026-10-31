// Mobil folyamatok (a tervezett kinézet szerint): Teendők a főoldalon, Bevétel / Kiadás lista (lejárt · e hónap · később,
// húzással +1 hó vagy bank párosítás), tétel-lap beépített naptárral, partner adatlap (lista és „hogyan fizet?” naptár).
import { useMemo, useRef, useState } from 'react';
import { displayGroup } from '../../shared/categories';
import { addMonths, fmt, monthLong, ymOf } from '../../shared/model';
import type { PartnerStat } from '../../shared/partners';
import type { Entry, Section } from '../../shared/types';
import { shiftDate } from './logic';
import { PartnerEditor } from './PartnerCard';
import { useStore } from './store';
import { C, FONT, FONT_H, R } from './ui';

const SM = ['jan.', 'febr.', 'márc.', 'ápr.', 'máj.', 'jún.', 'júl.', 'aug.', 'szept.', 'okt.', 'nov.', 'dec.'];
const MU = ['JAN', 'FEBR', 'MÁRC', 'ÁPR', 'MÁJ', 'JÚN', 'JÚL', 'AUG', 'SZEPT', 'OKT', 'NOV', 'DEC'];
const dayDiff = (a: string, b: string) => Math.round((Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / 86400000);
const shortDate = (d: string) => `${SM[Number(d.slice(5, 7)) - 1]} ${Number(d.slice(8))}.`;
const GOOD = C.inc;

// ───────────────────────── Teendők ─────────────────────────
export interface Todo {
  n: number;
  title: string;
  sub: string;
  action?: string;
  tone: 'red' | 'blue' | 'light';
  onClick: () => void;
}

export function TodoCard({ items }: { items: Todo[] }) {
  const shown = items.filter((t) => t.n > 0);
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', padding: '0 4px' }}>
        <b style={{ font: `700 19px ${FONT_H}`, color: C.navy }}>Teendők</b>
        <span style={{ font: `500 14px ${FONT}`, color: C.muted }}>{shown.length ? `${shown.length} csoport` : 'nincs teendő'}</span>
      </div>
      {shown.length > 0 && (
        <div style={{ background: '#fff', border: `1px solid ${C.line}`, borderRadius: R.lg, overflow: 'hidden' }}>
          {shown.map((t, i) => (
            <button
              key={t.title}
              onClick={t.onClick}
              style={{
                width: '100%',
                border: 0,
                borderTop: i ? `1px solid ${C.line3}` : 0,
                background: '#fff',
                padding: '14px 16px',
                display: 'flex',
                alignItems: 'center',
                gap: 14,
                textAlign: 'left',
                cursor: 'pointer',
              }}
            >
              <span
                style={{
                  width: 34,
                  height: 34,
                  flex: 'none',
                  borderRadius: '50%',
                  display: 'grid',
                  placeItems: 'center',
                  font: `700 14px ${FONT}`,
                  background: t.tone === 'red' ? C.neg : t.tone === 'blue' ? C.blue : C.bg2,
                  color: t.tone === 'light' ? C.blueDark : '#fff',
                }}
              >
                {t.n}
              </span>
              <span style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 2 }}>
                <b style={{ font: `600 16px ${FONT}`, color: C.ink }}>{t.title}</b>
                <span style={{ font: `500 13.5px ${FONT}`, color: C.muted }}>{t.sub}</span>
              </span>
              <span style={{ font: `600 15px ${FONT}`, color: C.blueDark, whiteSpace: 'nowrap' }}>{t.action ? `${t.action} ›` : '›'}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// ───────────────────────── Bevétel / Kiadás lista ─────────────────────────
type Seg = 'late' | 'cur' | 'later';

export function DueList({
  section,
  onOpen,
  onBankPick,
  initialSeg,
}: {
  section: Section;
  onOpen: (e: Entry) => void;
  onBankPick: (e: Entry) => void;
  initialSeg?: Seg;
}) {
  const { data, ix, commit, canEdit } = useStore();
  const [offers, setOffers] = useState(true);
  const today = data.today;
  const all = useMemo(
    () =>
      data.entries
        .filter((e) => e.kind === 'plan' && !e.done && e.amount !== 0 && ix.sectionOf(e.leaf_id) === section && (offers || !e.tentative))
        .sort((a, b) => a.date.localeCompare(b.date)),
    [data.entries, ix, section, offers],
  );
  const segOf = (e: Entry): Seg => (e.date < today ? 'late' : ymOf(e.date) === ix.cur ? 'cur' : 'later');
  const counts = { late: 0, cur: 0, later: 0 } as Record<Seg, number>;
  all.forEach((e) => counts[segOf(e)]++);
  const [seg, setSeg] = useState<Seg>(initialSeg || (counts.late ? 'late' : 'cur'));
  const rows = all.filter((e) => segOf(e) === seg);
  const total = rows.reduce((a, e) => a + Math.abs(e.amount), 0);
  const plusMonth = (e: Entry) =>
    commit(
      { upsert: [{ ...e, date: shiftDate(e.date, 1), period: e.period || ymOf(e.date) }] },
      `${e.name || ix.leafById[e.leaf_id]?.label}: +1 hó (${shortDate(shiftDate(e.date, 1))})`,
    );
  const segs: [Seg, string][] = [
    ['late', 'Lejárt'],
    ['cur', SM[Number(ix.cur.slice(5, 7)) - 1].replace(/^./, (c) => c.toUpperCase())],
    ['later', 'Később'],
  ];
  return (
    <div style={{ display: 'flex', flexDirection: 'column' }}>
      <div style={{ background: '#fff', padding: '14px 18px 14px', display: 'flex', flexDirection: 'column', gap: 12, borderBottom: `1px solid ${C.line}` }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10 }}>
          <b style={{ font: `800 26px ${FONT_H}`, color: C.navy }}>{section === 'in' ? 'Bevétel' : 'Kiadás'}</b>
          <button
            onClick={() => setOffers(!offers)}
            style={{
              height: 40,
              borderRadius: 999,
              border: `1.5px solid ${C.line2}`,
              background: '#fff',
              padding: '0 14px',
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              font: `600 14px ${FONT}`,
              color: C.navy,
            }}
          >
            <i
              style={{ width: 16, height: 16, borderRadius: R.sm, background: offers ? C.blue : 'transparent', border: offers ? 0 : `1.5px solid ${C.line2}` }}
            />
            Ajánlatokkal
          </button>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3,1fr)', background: C.bg2, borderRadius: 999, padding: 4, gap: 4 }}>
          {segs.map(([k, l]) => (
            <button
              key={k}
              onClick={() => setSeg(k)}
              style={{
                height: 40,
                border: 0,
                borderRadius: 999,
                background: seg === k ? (k === 'late' ? C.neg : C.navy) : 'transparent',
                color: seg === k ? '#fff' : C.ink,
                font: `600 14.5px ${FONT}`,
              }}
            >
              {l} {counts[k]}
            </button>
          ))}
        </div>
        <span style={{ font: `500 14px ${FONT}`, color: C.muted }}>
          {rows.length} tétel · összesen <b style={{ color: seg === 'late' ? C.neg : C.navy }}>{fmt(total)} Ft</b>
        </span>
      </div>
      <div style={{ padding: '14px 16px 24px', display: 'flex', flexDirection: 'column', gap: 12 }}>
        {!rows.length && <span style={{ padding: 18, font: `500 14px ${FONT}`, color: C.muted, textAlign: 'center' }}>Nincs tétel.</span>}
        {rows.map((e) => (
          <DueCard
            key={e.id}
            e={e}
            today={today}
            label={ix.leafById[e.leaf_id]?.label || e.name}
            canEdit={canEdit}
            onOpen={() => onOpen(e)}
            onPlus={() => plusMonth(e)}
            onBank={() => onBankPick(e)}
          />
        ))}
        {rows.length > 0 && canEdit && (
          <span style={{ textAlign: 'center', font: `500 13px ${FONT}`, color: C.muted }}>← balra húzva: +1 hó · jobbra: bank párosítás</span>
        )}
      </div>
    </div>
  );
}

function DueCard({
  e,
  today,
  label,
  canEdit,
  onOpen,
  onPlus,
  onBank,
}: {
  e: Entry;
  today: string;
  label: string;
  canEdit: boolean;
  onOpen: () => void;
  onPlus: () => void;
  onBank: () => void;
}) {
  const t = useRef<{ x: number; y: number } | null>(null);
  const [dx, setDx] = useState(0);
  const late = dayDiff(e.date, today);
  const offer = !!e.tentative;
  const status = offer
    ? `ajánlat${late > 0 ? ` · ${late} napja lejárt` : ''}`
    : late > 0
      ? `${late} napja lejárt`
      : late === 0
        ? 'ma esedékes'
        : `${-late} nap múlva`;
  return (
    <div
      onTouchStart={(ev) => (t.current = { x: ev.touches[0].clientX, y: ev.touches[0].clientY })}
      onTouchMove={(ev) => {
        if (!t.current || !canEdit) return;
        const x = ev.touches[0].clientX - t.current.x;
        if (Math.abs(x) > Math.abs(ev.touches[0].clientY - t.current.y)) setDx(Math.max(-90, Math.min(90, x)));
      }}
      onTouchEnd={() => {
        const d = dx;
        t.current = null;
        setDx(0);
        if (d <= -70) onPlus();
        else if (d >= 70 && !offer) onBank();
      }}
      onClick={onOpen}
      style={{
        background: '#fff',
        border: offer ? `1.5px dashed ${C.line2}` : `1px solid ${C.line}`,
        borderRadius: R.lg,
        padding: '14px 16px',
        display: 'flex',
        alignItems: 'center',
        gap: 14,
        transform: dx ? `translateX(${dx}px)` : undefined,
        transition: dx ? undefined : 'transform .2s',
        cursor: 'pointer',
      }}
    >
      <span style={{ width: 48, flex: 'none', display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
        <b style={{ font: `800 24px/1 ${FONT_H}`, color: C.navy }}>{e.date.slice(8)}</b>
        <span style={{ font: `600 12px ${FONT}`, color: C.muted, marginTop: 4 }}>{MU[Number(e.date.slice(5, 7)) - 1]}</span>
      </span>
      <span style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 4 }}>
        <b style={{ font: `600 16.5px ${FONT}`, color: C.ink, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{label}</b>
        {e.name && e.name !== label && (
          <span style={{ font: `500 12.5px ${FONT}`, color: C.muted, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{e.name}</span>
        )}
        <span style={{ font: `600 13.5px ${FONT}`, color: late > 0 && !offer ? C.neg : C.muted }}>{status}</span>
      </span>
      <span style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 8 }}>
        <b style={{ font: `700 18px ${FONT_H}`, color: C.navy, fontVariantNumeric: 'tabular-nums' }}>{fmt(Math.abs(e.amount))}</b>
        {canEdit &&
          (offer ? (
            <button
              onClick={(ev) => (ev.stopPropagation(), onPlus())}
              style={{
                height: 36,
                borderRadius: 999,
                border: `1.5px solid ${C.line2}`,
                background: '#fff',
                padding: '0 16px',
                font: `700 14px ${FONT}`,
                color: C.navy,
              }}
            >
              +1 hó
            </button>
          ) : (
            <button
              onClick={(ev) => (ev.stopPropagation(), onBank())}
              style={{
                height: 36,
                borderRadius: 999,
                border: 0,
                background: C.navy,
                color: '#fff',
                padding: '0 16px',
                font: `700 14px ${FONT}`,
                whiteSpace: 'nowrap',
              }}
            >
              ⇄ Bank párosítás
            </button>
          ))}
      </span>
    </div>
  );
}

// ───────────────────────── Tétel-lap (beépített naptárral) ─────────────────────────
export function PlanQuick({ plan, onEdit, onPartner }: { plan: Entry; onEdit: () => void; onPartner: (leaf: string) => void }) {
  const { data, ix, commit, canEdit } = useStore();
  const L = ix.leafById[plan.leaf_id];
  const sec = ix.sectionOf(plan.leaf_id);
  const late = dayDiff(plan.date, data.today);
  const doc = data.billingo.find((d) => d.plan_id === plan.id);
  const nav = (data.navInvoices || []).find((n) => n.plan_id === plan.id);
  const inv = doc ? `Számla: ${doc.number || ''}` : nav ? `Számla: ${nav.invoice_number}` : sec === 'in' ? 'Még nincs kiszámlázva' : 'Számla még nem érkezett';
  const setDate = (d: string) => {
    if (d === plan.date) return;
    commit(
      { upsert: [{ ...plan, date: d, period: plan.period || ymOf(plan.date) }] },
      `${plan.name || L?.label}: ${sec === 'in' ? 'várható beérkezés' : 'tervezett kifizetés'} ${d.replace(/-/g, '.')}.`,
    );
  };
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
        <span style={{ font: `500 14px ${FONT}`, color: C.muted }}>
          {L?.label} · {displayGroup(ix.groupById[L?.group_id || '']?.label || '')}
        </span>
        <b style={{ font: `800 26px/1.15 ${FONT_H}`, color: C.navy }}>{plan.name || L?.label}</b>
      </div>
      <div
        style={{ background: C.bg, borderRadius: R.lg, padding: '16px 18px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10 }}
      >
        <b style={{ font: `800 34px ${FONT_H}`, color: C.navy, fontVariantNumeric: 'tabular-nums' }}>
          {fmt(Math.abs(plan.amount))} <small style={{ font: `600 16px ${FONT}`, color: C.muted }}>Ft</small>
        </b>
        <span style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end' }}>
          <b style={{ font: `600 15px ${FONT}`, color: C.navy }}>{shortDate(plan.date)}</b>
          {!plan.done && late > 0 && <span style={{ font: `600 13px ${FONT}`, color: C.neg }}>{late} napja lejárt</span>}
          {plan.done ? <span style={{ font: `600 13px ${FONT}`, color: GOOD }}>✓ teljesült</span> : null}
        </span>
      </div>
      <span style={{ font: `500 14px ${FONT}`, color: C.muted }}>
        {inv} ·{' '}
        <a href="#" onClick={(ev) => (ev.preventDefault(), onPartner(plan.leaf_id))} style={{ color: C.blueDark, fontWeight: 600, textDecoration: 'none' }}>
          {L?.label} adatlap ›
        </a>
      </span>
      {canEdit && !plan.done && (
        <>
          <span style={{ font: `600 12px ${FONT}`, letterSpacing: '.14em', textTransform: 'uppercase', color: C.muted }}>
            {sec === 'in' ? 'Várható beérkezés' : 'Tervezett kifizetés'}
          </span>
          <div style={{ display: 'flex', gap: 10 }}>
            <span
              style={{
                flex: 1,
                height: 50,
                borderRadius: R.lg,
                border: `2px solid ${C.blue}`,
                background: C.bg2,
                display: 'flex',
                alignItems: 'center',
                gap: 10,
                padding: '0 14px',
                font: `600 17px ${FONT}`,
                color: C.navy,
              }}
            >
              📅 {plan.date.slice(0, 4)}. {shortDate(plan.date)}
            </span>
            <button
              onClick={() => setDate(shiftDate(plan.date, 1))}
              style={{ height: 50, borderRadius: R.lg, border: 0, background: C.navy, color: '#fff', padding: '0 20px', font: `700 16px ${FONT}` }}
            >
              +1 hó
            </button>
          </div>
          <MiniCalendar value={plan.date} today={data.today} onPick={setDate} />
        </>
      )}
      <button
        onClick={onEdit}
        style={{ height: 54, borderRadius: 999, border: `1.5px solid ${C.line2}`, background: '#fff', font: `700 16px ${FONT}`, color: C.navy }}
      >
        Szerkesztés
      </button>
    </div>
  );
}

/** Beépített havi naptár (hétfővel kezdődik); a hétvége halványabb, a kiválasztott nap kiemelve. */
export function MiniCalendar({ value, today, onPick }: { value: string; today: string; onPick: (d: string) => void }) {
  const [ym, setYm] = useState(value.slice(0, 7));
  const y = Number(ym.slice(0, 4)),
    m = Number(ym.slice(5, 7));
  const first = new Date(Date.UTC(y, m - 1, 1)).getUTCDay();
  const lead = (first + 6) % 7;
  const days = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const cells: (number | null)[] = [...Array(lead).fill(null), ...Array.from({ length: days }, (_, i) => i + 1)];
  const iso = (d: number) => `${ym}-${String(d).padStart(2, '0')}`;
  return (
    <div style={{ border: `1px solid ${C.line}`, borderRadius: R.lg, padding: '12px 14px' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 }}>
        <button
          onClick={() => setYm(addMonths(ym, -1))}
          style={{ border: 0, background: 'transparent', font: `700 20px ${FONT}`, color: C.navy, padding: '0 8px' }}
        >
          ‹
        </button>
        <b style={{ font: `700 17px ${FONT_H}`, color: C.navy }}>{monthLong(ym)}</b>
        <button
          onClick={() => setYm(addMonths(ym, 1))}
          style={{ border: 0, background: 'transparent', font: `700 20px ${FONT}`, color: C.navy, padding: '0 8px' }}
        >
          ›
        </button>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7,1fr)', gap: 4, textAlign: 'center' }}>
        {['H', 'K', 'Sze', 'Cs', 'P', 'Szo', 'V'].map((d) => (
          <span key={d} style={{ font: `600 12.5px ${FONT}`, color: C.muted, padding: '4px 0' }}>
            {d}
          </span>
        ))}
        {cells.map((d, i) => {
          if (!d) return <span key={'x' + i} />;
          const sel = iso(d) === value;
          const we = i % 7 >= 5;
          const isToday = iso(d) === today;
          return (
            <button
              key={i}
              onClick={() => onPick(iso(d))}
              style={{
                height: 40,
                border: isToday && !sel ? `1.5px solid ${C.line2}` : 0,
                borderRadius: 999,
                background: sel ? C.blue : 'transparent',
                color: sel ? '#fff' : we ? C.muted2 : C.ink,
                font: `${sel ? 700 : 500} 16px ${FONT}`,
              }}
            >
              {d}
            </button>
          );
        })}
      </div>
    </div>
  );
}

// ───────────────────────── Partner adatlap (mobil) ─────────────────────────
type Hist = { ym: string; name: string; amount: number; late: number | null; open: boolean; issued: string | null; paid: string | null; number: string | null };

export function MobilePartnerScreen({
  p,
  onClose,
  onNewItem,
  onEditItem,
}: {
  p: PartnerStat;
  onClose: () => void;
  onNewItem: (leaf: string) => void;
  onEditItem: (leaf: string) => void;
}) {
  const { data, ix } = useStore();
  const [view, setView] = useState<'list' | 'cal' | 'company'>('list');
  const [all, setAll] = useState(false);
  const [pick, setPick] = useState<string | null>(null);
  const byId = useMemo(() => new Map(data.entries.map((e) => [e.id, e])), [data.entries]);
  // előzmények: számlák (számla → fizetés, késéssel); számla nélkül a tények
  const hist: Hist[] = useMemo(() => {
    if (p.invoices.length)
      return p.invoices
        .map((i) => {
          const pl = i.doc.plan_id ? byId.get(i.doc.plan_id) : undefined;
          return {
            ym: (i.doc.invoice_date || i.doc.due_date || '').slice(0, 7),
            name: (pl?.name || 'Számla').replace(/\s*–\s*\d{4}\.\s*\S+$/, ''),
            amount: i.doc.gross,
            late: i.lateDays,
            open: i.lateDays === null,
            issued: i.doc.invoice_date,
            paid: i.doc.paid_date,
            number: i.doc.number,
          };
        })
        .filter((h) => h.ym)
        .sort((a, b) => b.ym.localeCompare(a.ym));
    return p.past
      .map((e) => ({ ym: ymOf(e.date), name: e.name || 'tény', amount: Math.abs(e.amount), late: 0, open: false, issued: null, paid: e.date, number: null }))
      .sort((a, b) => b.ym.localeCompare(a.ym));
  }, [p, byId]);
  const next = [...p.future].filter((e) => e.kind === 'plan' && !e.done).sort((a, b) => a.date.localeCompare(b.date))[0];
  const lateNow = p.outstanding || p.future.filter((e) => e.kind === 'plan' && !e.done && e.date < data.today).reduce((a, e) => a + Math.abs(e.amount), 0);
  const side = p.sides.in || p.sides.out;
  const chip = (h: Hist) =>
    h.open
      ? ['nyitott', '#fff', C.neg]
      : h.late == null || h.late <= 0
        ? ['időben', C.blueDark, C.bg2]
        : h.late < 30
          ? [`${h.late} nap`, C.blueDark, C.bg2]
          : [`${h.late} nap`, C.neg, C.negBg];
  const tone = (h?: Hist) => (!h ? 'empty' : h.open ? 'open' : h.late == null || h.late <= 0 ? 'ok' : h.late < 30 ? 'lt30' : h.late < 90 ? 'lt90' : 'late');
  const TONE: Record<string, React.CSSProperties> = {
    empty: { border: `1.5px dashed ${C.line2}` },
    ok: { background: C.blue },
    lt30: { background: '#C3DCEB' },
    lt90: { background: C.negLight },
    late: { background: C.neg },
    open: { border: `2.5px solid #B5443A`, background: '#fff' },
  };
  const card: React.CSSProperties = { background: '#fff', border: `1px solid ${C.line}`, borderRadius: R.lg };
  const leaf = p.leaves[0]?.id;
  return (
    <div style={{ position: 'fixed', inset: 0, background: C.bg, zIndex: 950, overflow: 'auto' }}>
      <div style={{ background: '#fff', padding: '14px 18px 16px', display: 'flex', flexDirection: 'column', gap: 14, borderBottom: `1px solid ${C.line}` }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <button
            onClick={() => (view === 'company' ? setView('list') : onClose())}
            style={{ border: 0, background: 'transparent', font: `700 26px ${FONT}`, color: C.navy }}
          >
            ‹
          </button>
          <b style={{ flex: 1, minWidth: 0, font: `800 26px ${FONT_H}`, color: C.navy, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
            {p.name}
          </b>
          <button onClick={() => setView('company')} style={{ border: 0, background: 'transparent', font: `600 15px ${FONT}`, color: C.blueDark }}>
            Cégadatok
          </button>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3,1fr)', gap: 8 }}>
          {(
            [
              ['Lejárt', fmt(lateNow), lateNow > 0],
              ['Átl. késés', p.avgLate == null ? '–' : `${Math.round(p.avgLate)} nap`, false],
              ['12 hó', fmt(side?.last12 || 0), false],
            ] as [string, string, boolean][]
          ).map(([l, v, red]) => (
            <span
              key={l}
              style={{ background: red ? C.negBg : C.bg, borderRadius: R.lg, padding: '10px 12px', display: 'flex', flexDirection: 'column', gap: 2 }}
            >
              <span style={{ font: `500 13px ${FONT}`, color: red ? C.neg : C.muted }}>{l}</span>
              <b style={{ font: `800 20px ${FONT_H}`, color: red ? C.neg : C.navy, fontVariantNumeric: 'tabular-nums' }}>{v}</b>
            </span>
          ))}
        </div>
        {view !== 'company' && (
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', background: C.bg2, borderRadius: 999, padding: 4, gap: 4 }}>
            {(
              [
                ['list', 'Lista'],
                ['cal', 'Hogyan fizet?'],
              ] as const
            ).map(([k, l]) => (
              <button
                key={k}
                onClick={() => setView(k)}
                style={{
                  height: 36,
                  border: 0,
                  borderRadius: 999,
                  background: view === k ? C.navy : 'transparent',
                  color: view === k ? '#fff' : C.ink,
                  font: `600 14px ${FONT}`,
                }}
              >
                {l}
              </button>
            ))}
          </div>
        )}
      </div>
      <div style={{ padding: '16px 16px 40px', display: 'flex', flexDirection: 'column', gap: 14 }}>
        {view === 'company' && (
          <div style={{ ...card, padding: 14 }}>
            <PartnerEditor key={p.key + (p.info?.updated_at || 0)} p={p} part="company" compact />
          </div>
        )}
        {view === 'list' && (
          <>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', padding: '0 4px' }}>
              <b style={{ font: `700 18px ${FONT_H}`, color: C.navy }}>Következő</b>
              {leaf && (
                <button onClick={() => onNewItem(leaf)} style={{ border: 0, background: 'transparent', font: `600 15px ${FONT}`, color: C.blueDark }}>
                  + Új tétel
                </button>
              )}
            </div>
            {next ? (
              <button
                onClick={() => onEditItem(next.leaf_id)}
                style={{ ...card, padding: '14px 18px', display: 'flex', alignItems: 'center', gap: 10, textAlign: 'left', cursor: 'pointer' }}
              >
                <span style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 3 }}>
                  <b style={{ font: `600 17px ${FONT}`, color: C.ink }}>{next.name || p.name}</b>
                  <span style={{ font: `600 13.5px ${FONT}`, color: next.date < data.today ? C.neg : C.muted }}>
                    {shortDate(next.date)}
                    {next.date < data.today ? ` · ${dayDiff(next.date, data.today)} napja lejárt` : ''}
                  </span>
                </span>
                <b style={{ font: `700 19px ${FONT_H}`, color: C.navy, fontVariantNumeric: 'tabular-nums' }}>{fmt(Math.abs(next.amount))}</b>
              </button>
            ) : (
              <span style={{ ...card, padding: 14, font: `500 14px ${FONT}`, color: C.muted }}>Nincs nyitott tétel.</span>
            )}
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', padding: '6px 4px 0' }}>
              <b style={{ font: `700 18px ${FONT_H}`, color: C.navy }}>Előzmények</b>
              <span style={{ font: `500 14px ${FONT}`, color: C.muted }}>{p.invoices.length ? 'számla → fizetés' : 'tények'}</span>
            </div>
            <div style={{ ...card, overflow: 'hidden' }}>
              {(all ? hist : hist.slice(0, 6)).map((h, i) => {
                const [cl, cc, cb] = chip(h);
                return (
                  <div
                    key={i}
                    style={{
                      display: 'grid',
                      gridTemplateColumns: '84px 1fr auto auto',
                      gap: 10,
                      alignItems: 'center',
                      padding: '12px 16px',
                      borderTop: i ? `1px solid ${C.line3}` : 0,
                    }}
                  >
                    <span style={{ font: `500 14px ${FONT}`, color: C.muted }}>
                      {h.ym.slice(0, 4)} {SM[Number(h.ym.slice(5, 7)) - 1].replace('.', '')}
                    </span>
                    <span style={{ font: `500 15px ${FONT}`, color: C.ink, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{h.name}</span>
                    <span style={{ padding: '3px 10px', borderRadius: 999, background: cb, color: cc, font: `600 12.5px ${FONT}`, whiteSpace: 'nowrap' }}>
                      {cl}
                    </span>
                    <b style={{ font: `600 15px ${FONT}`, color: C.ink, fontVariantNumeric: 'tabular-nums', minWidth: 74, textAlign: 'right' }}>
                      {fmt(h.amount)}
                    </b>
                  </div>
                );
              })}
              {hist.length > 6 && (
                <button
                  onClick={() => setAll(!all)}
                  style={{
                    width: '100%',
                    border: 0,
                    borderTop: `1px solid ${C.line3}`,
                    background: '#fff',
                    padding: 14,
                    font: `600 15px ${FONT}`,
                    color: C.blueDark,
                  }}
                >
                  {all ? 'Kevesebb' : `Mind (${hist.length}) ›`}
                </button>
              )}
              {!hist.length && <span style={{ display: 'block', padding: 14, font: `500 14px ${FONT}`, color: C.muted }}>Még nincs előzmény.</span>}
            </div>
          </>
        )}
        {view === 'cal' &&
          (() => {
            // év × hónap rács: a hónap számlája milyen késéssel lett fizetve
            const byYm = new Map<string, Hist>();
            for (const h of hist) if (!byYm.has(h.ym)) byYm.set(h.ym, h);
            const years = [...new Set(hist.map((h) => h.ym.slice(0, 4)))].sort().slice(-3);
            if (!years.length) years.push(ix.cur.slice(0, 4));
            const cnt = { ok: 0, lt30: 0, lt90: 0, late: 0, open: 0 } as Record<string, number>;
            for (const h of byYm.values()) if (years.includes(h.ym.slice(0, 4))) cnt[tone(h)]++;
            const sel = pick ? byYm.get(pick) : undefined;
            return (
              <>
                <div style={{ ...card, padding: 16, display: 'flex', flexDirection: 'column', gap: 12 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
                    <b style={{ font: `700 18px ${FONT_H}`, color: C.navy }}>Hogyan fizet?</b>
                    <span style={{ font: `500 14px ${FONT}`, color: C.muted }}>{byYm.size} számla</span>
                  </div>
                  <div style={{ display: 'grid', gridTemplateColumns: `44px repeat(12,1fr)`, gap: 4, alignItems: 'center' }}>
                    <span />
                    {['J', 'F', 'M', 'Á', 'M', 'J', 'J', 'A', 'Sz', 'O', 'N', 'D'].map((d, i) => (
                      <span key={i} style={{ textAlign: 'center', font: `600 11px ${FONT}`, color: C.muted }}>
                        {d}
                      </span>
                    ))}
                    {years.map((y) => [
                      <span key={y} style={{ font: `600 13px ${FONT}`, color: C.ink }}>
                        {y}
                      </span>,
                      ...Array.from({ length: 12 }, (_, i) => {
                        const ym = `${y}-${String(i + 1).padStart(2, '0')}`;
                        const h = byYm.get(ym);
                        return (
                          <button
                            key={ym}
                            onClick={() => h && setPick(ym)}
                            title={h ? `${monthLong(ym)}: ${chip(h)[0]}` : monthLong(ym)}
                            style={{
                              aspectRatio: '1',
                              borderRadius: R.md,
                              border: 0,
                              padding: 0,
                              outline: pick === ym ? `2px solid ${C.navy}` : undefined,
                              outlineOffset: 1,
                              ...TONE[tone(h)],
                            }}
                          />
                        );
                      }),
                    ])}
                  </div>
                  <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', font: `500 13px ${FONT}`, color: C.ink }}>
                    {(
                      [
                        ['ok', 'időben'],
                        ['lt30', '<30 nap'],
                        ['lt90', '30–90 nap'],
                        ['late', '90+ nap'],
                        ['open', 'nyitott'],
                      ] as const
                    ).map(([k, l]) => (
                      <span key={k} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                        <i style={{ width: 13, height: 13, borderRadius: R.sm, ...TONE[k] }} />
                        {l} {cnt[k]}
                      </span>
                    ))}
                  </div>
                </div>
                {sel ? (
                  <div style={{ ...card, border: `2px solid ${C.navy}`, padding: 16, display: 'flex', flexDirection: 'column', gap: 10 }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10 }}>
                      <b style={{ font: `700 18px ${FONT_H}`, color: C.navy }}>
                        {monthLong(sel.ym)} · {sel.name}
                      </b>
                      <b style={{ font: `700 18px ${FONT_H}`, color: C.navy }}>{fmt(sel.amount)}</b>
                    </div>
                    <div style={{ display: 'grid', gridTemplateColumns: 'auto 1fr auto', gap: 10, alignItems: 'center' }}>
                      <span style={{ display: 'flex', flexDirection: 'column' }}>
                        <span style={{ font: `600 11px ${FONT}`, letterSpacing: '.1em', color: C.muted }}>SZÁMLA</span>
                        <b style={{ font: `600 15px ${FONT}`, color: C.navy }}>{sel.issued ? shortDate(sel.issued) : '–'}</b>
                      </span>
                      <span style={{ height: 4, borderRadius: R.sm, background: tone(sel) === 'ok' ? C.blue : C.neg }} />
                      <span style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end' }}>
                        <span style={{ font: `600 11px ${FONT}`, letterSpacing: '.1em', color: C.muted }}>{sel.open ? 'NYITOTT' : 'FIZETVE'}</span>
                        <b style={{ font: `600 15px ${FONT}`, color: C.navy }}>{sel.paid ? shortDate(sel.paid) : '–'}</b>
                      </span>
                    </div>
                    <span
                      style={{
                        alignSelf: 'flex-start',
                        padding: '5px 12px',
                        borderRadius: 999,
                        background: chip(sel)[2],
                        color: chip(sel)[1],
                        font: `600 13.5px ${FONT}`,
                      }}
                    >
                      {sel.open ? 'nyitott' : sel.late && sel.late > 0 ? `${sel.late} nap késés` : 'időben'}
                      {sel.number ? ` · ${sel.number}` : ''}
                    </span>
                  </div>
                ) : (
                  <span style={{ textAlign: 'center', font: `500 14px ${FONT}`, color: C.muted }}>Koppints egy hónapra a részletekért</span>
                )}
              </>
            );
          })()}
      </div>
    </div>
  );
}

/** A főoldal teendői a mostani adatokból. */
export function useTodos(o: { flagsUninvoiced: number; merge: number; newTx: number; go: (to: 'lateIn' | 'lateOut' | 'bank' | 'merge') => void }): Todo[] {
  const { data, ix } = useStore();
  const lateOf = (s: Section) =>
    data.entries.filter((e) => e.kind === 'plan' && !e.done && !e.tentative && e.amount !== 0 && e.date < data.today && ix.sectionOf(e.leaf_id) === s);
  const li = lateOf('in'),
    lo = lateOf('out');
  const sum = (es: Entry[]) => es.reduce((a, e) => a + Math.abs(e.amount), 0);
  return [
    { n: li.length, title: 'Lejárt kintlévőség', sub: `${fmt(sum(li))} Ft`, action: 'Megnyit', tone: 'red', onClick: () => o.go('lateIn') },
    { n: lo.length, title: 'Lejárt kifizetés', sub: `${fmt(sum(lo))} Ft`, action: 'Megnyit', tone: 'red', onClick: () => o.go('lateOut') },
    { n: o.newTx, title: 'Banki tétel jóváhagyásra', sub: 'párosítás kész', action: 'Jóváhagy', tone: 'blue', onClick: () => o.go('bank') },
    { n: o.flagsUninvoiced, title: 'Kiszámlázandó', sub: 'ebben a hónapban', tone: 'light', onClick: () => o.go('merge') },
    { n: o.merge, title: 'Összevonás', sub: 'terv – számla – tény, nevek', tone: 'light', onClick: () => o.go('merge') },
  ];
}
