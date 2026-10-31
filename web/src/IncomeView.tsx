// Tervezett bevételek, kiadások: melyik tételt mikor fizetik / fizetjük (Billingo- és NAV-számlák, tervek), táblázatban hónaponként;
// a sorra állva műveletek (bank párosítás, dátum, +1 hó); jobbra a hónapban beérkezett tételek.
import { hasMonth } from '../../shared/monthname';
import { useState } from 'react';
import { addMonths, endOfMonth, fmt, monthLabel, monthLong, ymOf } from '../../shared/model';
import type { Entry, Section } from '../../shared/types';
import { api } from './api';
import { BankPickDialog } from './BankPick';
import { CalendarSheet } from './DatePicker';
import { itemLabel } from './MonthList';
import { usePlanOfActual } from './LinkChain';
import { PartnerLink } from './PartnerCard';
import { markDone, shiftDate } from './logic';
import { useStore } from './store';
import { C, FONT, FONT_H, Seg, card, SyncPill } from './ui';

const dm = (d: string) => `${d.slice(5, 7)}.${d.slice(8, 10)}.`;

export function IncomeView({ mobile, onOpen }: { mobile?: boolean; onOpen?: (e: Entry) => void }) {
  const { ix, data, commit, run, canEdit } = useStore();
  const [side, setSide] = useState<Section | 'all'>('in');
  const [q, setQ] = useState('');
  // a fejléc dobozaira kattintva csak a hozzájuk tartozó tételek látszanak
  const [focus, setFocus] = useState<'all' | 'open' | 'overdue' | 'billingo' | 'offers'>('all');
  // alapból 3 hónap (az aktuális és a következő kettő); a lista alján egy-egy hónappal bővíthető
  const [more, setMore] = useState(0);
  const [hov, setHov] = useState<string | null>(null);
  const [pickFor, setPickFor] = useState<Entry | null>(null);
  const [bankFor, setBankFor] = useState<Entry | null>(null);
  const [allIn, setAllIn] = useState(false);
  const planOfActual = usePlanOfActual();

  const inSide = (e: Entry) => side === 'all' || ix.sectionOf(e.leaf_id) === side;
  const isOut = (e: Entry) => ix.sectionOf(e.leaf_id) === 'out';
  const partnerOf = (e: Entry) => ix.leafById[e.leaf_id]?.label || e.name;
  const qq = q.trim().toLowerCase();
  const matchQ = (e: Entry) => !qq || `${partnerOf(e)} ${e.name}`.toLowerCase().includes(qq);
  const navByPlan = new Map((data.navInvoices || []).filter((d) => d.plan_id).map((d) => [d.plan_id!, d]));
  const docByPlan = new Map(data.billingo.filter((d) => d.plan_id).map((d) => [d.plan_id!, d]));
  // havidíjas (ismétlődő) tételnél a hónap is a névben: „Havi díj – 2026. november”
  const repOf = new Map(data.series.map((x) => [x.id, x.rep]));
  const withMonth = (e: Entry, label: string) =>
    e.series_id && repOf.get(e.series_id) && repOf.get(e.series_id) !== 'once' && !hasMonth(label || e.name)
      ? `${label || e.name} – ${monthLong(e.period || ymOf(e.date))}`
      : label;

  const lastMonth = addMonths(ix.cur, 2 + more);
  const horizon = endOfMonth(lastMonth);
  const base = data.entries.filter(
    (e) => e.kind === 'plan' && !e.done && inSide(e) && matchQ(e) && (e.date >= addMonths(ix.cur, -6) + '-01' || e.source === 'billingo'),
  );
  const open = base.filter((e) => e.date <= horizon);
  const isLate = (e: Entry) => e.date < data.today && !e.tentative;
  const isInvoiced = (e: Entry) => e.source === 'billingo' || docByPlan.has(e.id) || navByPlan.has(e.id);
  const firm = open.filter((e) => !e.tentative);
  const overdue = open.filter(isLate);
  const invoiced = open.filter((e) => isInvoiced(e) && !e.tentative);
  const offers = open.filter((e) => e.tentative);
  const sumAbs = (es: Entry[]) => es.reduce((s, e) => s + Math.abs(e.amount), 0);
  const shown = open.filter((e) =>
    focus === 'open'
      ? !e.tentative
      : focus === 'overdue'
        ? isLate(e)
        : focus === 'billingo'
          ? isInvoiced(e) && !e.tentative
          : focus === 'offers'
            ? !!e.tentative
            : true,
  );
  // csoportok: előbb az összes lejárt, utána hónaponként
  const groups = new Map<string, Entry[]>();
  shown
    .sort((a, b) => a.date.localeCompare(b.date))
    .forEach((e) => {
      const k = isLate(e) ? 'overdue' : ymOf(e.date);
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k)!.push(e);
    });
  const order = [...groups.keys()].sort((a, b) => (a === 'overdue' ? -1 : b === 'overdue' ? 1 : a.localeCompare(b)));
  const nextYm = addMonths(lastMonth, 1);
  const nextN = base.filter((e) => ymOf(e.date) === nextYm).length;

  // beérkezett / kifizetett tételek az aktuális hónapban
  const received = data.entries.filter((e) => e.kind === 'actual' && inSide(e) && ymOf(e.date) === ix.cur).sort((a, b) => b.date.localeCompare(a.date));
  const dupOf = (e: Entry) => received.find((x) => x.id !== e.id && x.leaf_id === e.leaf_id && Math.abs(x.amount) === Math.abs(e.amount) && x.date > e.date);
  const devN = received.filter((e) => {
    const p = planOfActual.get(e.id);
    return p && Math.round(Math.abs(e.amount) - Math.abs(p.amount));
  }).length;
  const recTotal = received.reduce((s, e) => s + e.amount, 0);

  const sync = () => run(() => api('/api/sync', { body: {} }), 'Szinkron kész');
  const plusMonth = (e: Entry) =>
    commit({ upsert: [{ ...e, date: shiftDate(e.date, 1), period: e.period || ymOf(e.date) }] }, `${partnerOf(e)}: +1 hó (${dm(shiftDate(e.date, 1))})`);
  const pickFocus = (f: typeof focus) => setFocus(focus === f ? 'all' : f);
  const sideWord = side === 'out' ? 'kiadás' : side === 'in' ? 'bevétel' : 'tétel';

  const chip = (f: typeof focus, label: string, value: number, n: number, tone: 'dark' | 'red' | 'plain' | 'dashed') => {
    const on = focus === f;
    const dark = tone === 'dark';
    return (
      <button
        type="button"
        onClick={() => pickFocus(f)}
        style={{
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'flex-start',
          gap: 2,
          padding: '9px 14px',
          borderRadius: 12,
          cursor: 'pointer',
          textAlign: 'left',
          background: dark ? C.navy : tone === 'red' ? C.negBg : '#fff',
          border: dark ? 0 : `1px ${tone === 'dashed' ? 'dashed' : 'solid'} ${tone === 'red' ? C.negLight : C.line2}`,
          outline: on ? `3px solid ${C.blue}` : 'none',
          outlineOffset: 2,
        }}
      >
        <span style={{ font: `500 12px ${FONT}`, color: dark ? C.muted2 : tone === 'red' ? C.neg : C.muted }}>{label}</span>
        <b
          style={{
            font: `700 16px ${FONT_H}`,
            color: dark ? '#fff' : tone === 'red' ? C.neg : C.navy,
            fontVariantNumeric: 'tabular-nums',
            whiteSpace: 'nowrap',
          }}
        >
          {fmt(value)} Ft · {n}
        </b>
      </button>
    );
  };

  const COLS = 'minmax(64px,72px) minmax(0,1fr) 150px 120px';
  const th = { font: `600 11px ${FONT}`, letterSpacing: '.12em', textTransform: 'uppercase' as const, color: C.muted };

  return (
    <div style={{ padding: mobile ? '14px 16px 120px' : '24px 28px 120px', display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 16, flexWrap: 'wrap' }}>
        <div>
          <h1 style={{ margin: 0, font: `800 30px/1.05 ${FONT_H}`, color: C.navy }}>Tervezett bevételek, kiadások</h1>
          <p style={{ margin: '6px 0 0', font: `400 14px ${FONT}`, color: C.muted }}>
            Mikor fizetnek nekünk, mikor fizetünk mi · Billingo-számlák automatikusan bekerülnek
          </p>
        </div>
        <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
          <Seg
            value={side}
            onChange={setSide}
            options={[
              ['all', 'Mind'],
              ['in', 'Bevételek'],
              ['out', 'Kiadások'],
            ]}
          />
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Partner, tétel…"
            style={{ border: `1px solid ${C.line2}`, borderRadius: 999, padding: '9px 16px', font: `500 13px ${FONT}`, width: 200, outline: 'none' }}
          />
          {canEdit && <SyncPill label="↻ Szinkron" onRun={sync} />}
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: mobile ? '1fr' : 'minmax(0,1fr) minmax(280px,370px)', gap: 16, alignItems: 'start' }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12, minWidth: 0 }}>
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
            {chip('open', `Nyitott · ${monthLabel(lastMonth).toLowerCase()} végéig`, sumAbs(firm), firm.length, 'dark')}
            {chip('overdue', 'Lejárt', sumAbs(overdue), overdue.length, 'red')}
            {chip('billingo', 'Számla kint', sumAbs(invoiced), invoiced.length, 'plain')}
            {chip('offers', 'Ajánlat (nem biztos)', sumAbs(offers), offers.length, 'dashed')}
            <span style={{ marginLeft: 'auto', font: `400 12.5px ${FONT}`, color: C.muted }}>
              {focus === 'all' ? (
                'kattints = szűrés'
              ) : (
                <button
                  onClick={() => setFocus('all')}
                  style={{ border: 0, background: 'transparent', color: C.blue, font: `600 12.5px ${FONT}`, cursor: 'pointer' }}
                >
                  szűrés törlése ✕
                </button>
              )}
            </span>
          </div>

          <div style={{ ...card, overflow: 'hidden' }}>
            <div style={{ display: 'grid', gridTemplateColumns: COLS, gap: 12, padding: '12px 16px', borderBottom: `1px solid ${C.line}` }}>
              <span style={th}>Dátum</span>
              <span style={th}>Partner · tétel</span>
              <span style={th}>Állapot</span>
              <span style={{ ...th, textAlign: 'right' }}>Összeg</span>
            </div>
            {order.length === 0 && (
              <div style={{ padding: 28, textAlign: 'center', color: C.muted, font: `500 14px ${FONT}` }}>Nincs nyitott tervezett {sideWord}.</div>
            )}
            {order.map((k) => {
              const es = groups.get(k)!;
              const late = k === 'overdue';
              const firmEs = es.filter((e) => !e.tentative);
              const offerSum = sumAbs(es.filter((e) => e.tentative));
              return (
                <div key={k}>
                  <div
                    style={{
                      display: 'grid',
                      gridTemplateColumns: COLS,
                      gap: 12,
                      alignItems: 'center',
                      padding: '11px 16px',
                      background: late ? C.negBg : C.bg3,
                      borderBottom: `1px solid ${C.line}`,
                      borderTop: `1px solid ${C.line}`,
                    }}
                  >
                    <span
                      style={{
                        gridColumn: '1 / span 2',
                        font: `700 13px ${FONT_H}`,
                        color: late ? C.neg : C.navy,
                        letterSpacing: '.04em',
                        textTransform: 'uppercase',
                      }}
                    >
                      {late ? 'Lejárt' : monthLong(k)}
                      <span style={{ font: `500 12.5px ${FONT}`, color: C.muted, letterSpacing: 0, textTransform: 'none', marginLeft: 10 }}>
                        {es.length} tétel
                      </span>
                    </span>
                    <span style={{ font: `500 12px ${FONT}`, color: C.muted }}>{offerSum ? `+ ajánlat ${fmt(offerSum)}` : ''}</span>
                    <b
                      style={{
                        textAlign: 'right',
                        font: `700 14px ${FONT}`,
                        color: late ? C.neg : C.navy,
                        fontVariantNumeric: 'tabular-nums',
                        whiteSpace: 'nowrap',
                      }}
                    >
                      {side === 'all'
                        ? `be ${fmt(sumAbs(firmEs.filter((e) => !isOut(e))))} · ki ${fmt(sumAbs(firmEs.filter(isOut)))}`
                        : `${fmt(sumAbs(firmEs))} Ft`}
                    </b>
                  </div>
                  {es.map((e) => {
                    const doc = docByPlan.get(e.id);
                    const nav = navByPlan.get(e.id);
                    const out = isOut(e);
                    const lt = isLate(e);
                    const days = Math.round((Date.parse(data.today) - Date.parse(e.date)) / 86400000);
                    const inv = doc?.number || nav?.invoice_number;
                    const label = withMonth(e, itemLabel(e.name, partnerOf(e)));
                    const showAct = canEdit && hov === e.id && !e.tentative;
                    return (
                      <div
                        key={e.id}
                        onMouseEnter={() => setHov(e.id)}
                        onMouseLeave={() => setHov((h) => (h === e.id ? null : h))}
                        onClick={() => onOpen?.(e)}
                        style={{
                          position: 'relative',
                          display: 'grid',
                          gridTemplateColumns: COLS,
                          gap: 12,
                          alignItems: 'center',
                          padding: '11px 16px',
                          borderTop: `1px solid ${C.line3}`,
                          background: hov === e.id ? C.bg3 : '#fff',
                          cursor: onOpen ? 'pointer' : undefined,
                        }}
                      >
                        <span style={{ font: `700 13.5px ${FONT_H}`, color: lt ? C.neg : C.navy, fontVariantNumeric: 'tabular-nums' }}>{dm(e.date)}</span>
                        <span
                          style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', font: `400 14px ${FONT}`, color: C.ink }}
                        >
                          <PartnerLink leaf={e.leaf_id} style={{ font: `700 14px ${FONT}`, color: C.navy }}>
                            {partnerOf(e)}
                          </PartnerLink>
                          {label && <span style={{ color: C.muted }}> · {label}</span>}
                          {inv && !(label || '').includes(inv) && <span style={{ color: C.muted }}> · {inv}</span>}
                        </span>
                        <span>
                          {lt ? (
                            <Tag color={C.neg} bg={C.negBg}>
                              {days} napja lejárt
                            </Tag>
                          ) : e.tentative ? (
                            <Tag color={C.muted} border={C.line2}>
                              ajánlat
                            </Tag>
                          ) : inv ? (
                            <Tag color={C.blueDark} bg={C.bg2}>
                              számla kint
                            </Tag>
                          ) : side === 'all' ? (
                            <Tag color={out ? C.neg : C.blueDark}>{out ? 'kiadás' : 'bevétel'}</Tag>
                          ) : null}
                        </span>
                        <b
                          style={{
                            textAlign: 'right',
                            font: `700 14px ${FONT}`,
                            color: e.tentative ? C.faint : out ? C.neg : C.navy,
                            fontVariantNumeric: 'tabular-nums',
                            whiteSpace: 'nowrap',
                          }}
                        >
                          {out ? '−' : ''}
                          {fmt(Math.abs(e.amount))}
                        </b>
                        {showAct && (
                          <span
                            onClick={(ev) => ev.stopPropagation()}
                            style={{
                              position: 'absolute',
                              right: 12,
                              top: '50%',
                              transform: 'translateY(-50%)',
                              display: 'flex',
                              gap: 6,
                              background: C.bg3,
                              paddingLeft: 8,
                            }}
                          >
                            <Act dark onClick={() => setBankFor(e)}>
                              ⇄ Bank párosítás
                            </Act>
                            <Act onClick={() => setPickFor(e)}>▭ Dátum</Act>
                            <Act onClick={() => plusMonth(e)}>+1 hó</Act>
                            {e.date <= data.today && (
                              <Act onClick={() => commit(markDone(data, [e.id], true), `${partnerOf(e)}: ${out ? 'kifizetve' : 'beérkezett'} ✓`)}>
                                ✓ {out ? 'Kifizetve' : 'Beérkezett'}
                              </Act>
                            )}
                          </span>
                        )}
                      </div>
                    );
                  })}
                </div>
              );
            })}
            <button
              type="button"
              onClick={() => setMore(more + 1)}
              title="Még egy hónap betöltése"
              style={{
                width: '100%',
                border: 0,
                borderTop: `1px solid ${C.line}`,
                background: '#fff',
                padding: '12px 16px',
                font: `600 13.5px ${FONT}`,
                color: C.blue,
                cursor: 'pointer',
              }}
            >
              + {monthLong(nextYm)} betöltése ({nextN} tétel) ▾
            </button>
          </div>
          <span style={{ font: `400 12px ${FONT}`, color: C.muted }}>A műveletek (bank párosítás, dátum, +1 hó) a sorra állva jelennek meg.</span>
        </div>

        <div style={{ ...card, padding: '16px 18px 8px', display: 'flex', flexDirection: 'column' }}>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 10 }}>
            <b style={{ flex: 1, font: `700 16px ${FONT_H}`, color: C.navy }}>
              {side === 'out' ? 'Kifizetve' : 'Beérkezett'} · {monthLong(ix.cur).replace(/^\d+\.\s*/, '')}
            </b>
            {received.length > 8 && (
              <button
                onClick={() => setAllIn(!allIn)}
                style={{ border: 0, background: 'transparent', color: C.blue, font: `600 12.5px ${FONT}`, cursor: 'pointer', padding: 0 }}
              >
                {allIn ? 'Kevesebb ‹' : `Mind (${received.length}) ›`}
              </button>
            )}
          </div>
          <span style={{ font: `400 13px ${FONT}`, color: C.muted, margin: '6px 0 8px' }}>
            Összesen{' '}
            <b style={{ color: recTotal < 0 ? C.neg : C.blueDark, marginLeft: 4 }}>
              {recTotal > 0 ? '+' : recTotal < 0 ? '−' : ''}
              {fmt(Math.abs(recTotal))}
            </b>{' '}
            · {devN} eltérés
          </span>
          {received.length === 0 && <div style={{ padding: '14px 0', color: C.muted, font: `500 13px ${FONT}` }}>Még nincs tétel ebben a hónapban.</div>}
          {(allIn ? received : received.slice(0, 8)).map((e) => {
            const p = planOfActual.get(e.id);
            const diff = p ? Math.abs(e.amount) - Math.abs(p.amount) : null;
            const dup = dupOf(e);
            return (
              <div
                key={e.id}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 12,
                  padding: '10px 8px',
                  margin: '0 -8px',
                  borderTop: `1px solid ${C.line3}`,
                  background: dup ? C.negBg : undefined,
                }}
              >
                <span style={{ width: 44, flex: 'none', font: `500 12.5px ${FONT}`, color: C.muted }}>{dm(e.date)}</span>
                <span style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', lineHeight: 1.3 }}>
                  <PartnerLink
                    leaf={e.leaf_id}
                    style={{ font: `600 13.5px ${FONT}`, color: C.navy, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                  >
                    {partnerOf(e)}
                  </PartnerLink>
                  <span style={{ font: `500 11.5px ${FONT}`, color: dup ? C.neg : diff ? C.blueDark : C.muted }}>
                    {dup
                      ? `⚠ duplikáció? ua. mint ${dm(dup.date)}`
                      : diff == null
                        ? e.source === 'bank'
                          ? 'bankból, terv nélkül'
                          : 'terv nélkül'
                        : Math.round(diff)
                          ? `eltérés ${diff > 0 ? '+' : '−'}${fmt(Math.abs(diff))}`
                          : 'pontosan a terv'}
                  </span>
                </span>
                <b style={{ font: `700 13.5px ${FONT}`, color: e.amount < 0 ? C.neg : C.blueDark, fontVariantNumeric: 'tabular-nums' }}>
                  {e.amount < 0 ? '−' : '+'}
                  {fmt(Math.abs(e.amount))}
                </b>
              </div>
            );
          })}
        </div>
      </div>

      {pickFor && (
        <CalendarSheet
          value={pickFor.date}
          onClose={() => setPickFor(null)}
          onPick={(v) => {
            const e = pickFor;
            setPickFor(null);
            // ismétlődő tételnél a hónap (melyik hónap díja) megmarad, csak a fizetés napja változik
            if (v !== e.date)
              commit(
                { upsert: [{ ...e, date: v, ...(e.series_id ? { period: e.period || ymOf(e.date) } : {}) }] },
                `${withMonth(e, e.name || 'Tétel')}: fizetési határidő ${v.replace(/-/g, '.')}.`,
              );
          }}
        />
      )}
      {bankFor && <BankPickDialog plan={bankFor} onClose={() => setBankFor(null)} />}
    </div>
  );
}

function Tag({ children, color, bg, border }: { children: React.ReactNode; color: string; bg?: string; border?: string }) {
  return (
    <span
      style={{
        display: 'inline-block',
        padding: '2px 9px',
        borderRadius: 999,
        background: bg || 'transparent',
        border: border ? `1px solid ${border}` : 0,
        color,
        font: `600 11.5px ${FONT}`,
        whiteSpace: 'nowrap',
      }}
    >
      {children}
    </span>
  );
}

function Act({ children, onClick, dark }: { children: React.ReactNode; onClick: () => void; dark?: boolean }) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        border: dark ? 0 : `1px solid ${C.line2}`,
        borderRadius: 999,
        background: dark ? C.navy : '#fff',
        color: dark ? '#fff' : C.blueDark,
        padding: '5px 11px',
        font: `600 12px ${FONT}`,
        cursor: 'pointer',
        whiteSpace: 'nowrap',
      }}
    >
      {children}
    </button>
  );
}

/** Kis címke (pl. Billingo-számla, státusz) – más nézetek is használják. */
export function Badge({ children, color, bg }: { children: React.ReactNode; color?: string; bg?: string }) {
  return (
    <span
      style={{
        flex: 'none',
        padding: '2px 8px',
        borderRadius: 999,
        background: bg || C.bg,
        color: color || C.muted,
        font: `600 11px ${FONT}`,
        whiteSpace: 'nowrap',
      }}
    >
      {children}
    </span>
  );
}
