// Tervezett bevételek, kiadások: melyik tételt mikor fizetik / fizetjük (Billingo- és NAV-számlák, tervek); a dátumra kattintva a határidő módosítható.
import { useRef, useState } from 'react';
import { addMonths, endOfMonth, fmt, monthLabel, monthLong, ymOf } from '../../shared/model';
import type { Entry, Section } from '../../shared/types';
import { api } from './api';
import { CalendarSheet } from './DatePicker';
import { itemLabel } from './MonthList';
import { PlanDiff, usePlanOfActual } from './LinkChain';
import { PartnerLink } from './PartnerCard';
import { markDone } from './logic';
import { useStore } from './store';
import { C, FONT, FONT_H, Pill, Seg, card, eyebrow, stamp, SyncPill } from './ui';

const BSTATUS: Record<string, [string, string]> = {
  outstanding: ['kiküldve, nyitott', C.blueDark],
  expired: ['lejárt (Billingo)', C.neg],
  partially_paid: ['részben fizetve', '#8A6D1C'],
  paid: ['Billingóban fizetve', C.blueDark],
  none: ['fizetési státusz nélkül', C.muted],
};

export function IncomeView({ mobile, onOpen }: { mobile?: boolean; onOpen?: (e: Entry) => void }) {
  const { ix, data, filters, commit, run, canEdit } = useStore();
  const [showOffers, setShowOffers] = useState(true);
  const [side, setSide] = useState<Section | 'all'>('all');
  const inSide = (e: Entry) => side === 'all' || ix.sectionOf(e.leaf_id) === side;
  const isOut = (e: Entry) => ix.sectionOf(e.leaf_id) === 'out';
  const navByPlan = new Map((data.navInvoices || []).filter((d) => d.plan_id).map((d) => [d.plan_id!, d]));
  // havidíjas (ismétlődő) tételnél a hónap is a névben: „Havi díj – 2026. november”
  const repOf = new Map(data.series.map((x) => [x.id, x.rep]));
  const withMonth = (e: Entry, label: string) =>
    e.series_id && repOf.get(e.series_id) && repOf.get(e.series_id) !== 'once' ? `${label || e.name} – ${monthLong(e.period || ymOf(e.date))}` : label;
  const planOfActual = usePlanOfActual();
  // a dátumra kattintva: a várható beérkezés módosítása
  const [pickFor, setPickFor] = useState<Entry | null>(null);
  // a fejléc dobozaira koppintva csak a hozzájuk tartozó tételek látszanak
  const [focus, setFocus] = useState<'all' | 'open' | 'overdue' | 'billingo' | 'offers'>('all');
  const listRef = useRef<HTMLDivElement>(null);
  const pickFocus = (f: typeof focus) => {
    setFocus(focus === f ? 'all' : f);
    if (f === 'offers') setShowOffers(true);
    setTimeout(() => listRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 50);
  };
  const horizon = endOfMonth(filters.to > ix.cur ? filters.to : addMonths(ix.cur, 3));
  const docByPlan = new Map(data.billingo.filter((d) => d.plan_id).map((d) => [d.plan_id!, d]));
  const income = data.entries.filter((e) => e.kind === 'plan' && inSide(e));
  const open = income.filter(
    (e) => !e.done && e.date <= horizon && (showOffers || !e.tentative) && (e.date >= addMonths(ix.cur, -6) + '-01' || e.source === 'billingo'),
  );
  const overdue = open.filter((e) => e.date < data.today && !e.tentative);
  const received = data.entries
    .filter((e) => e.kind === 'actual' && inSide(e) && e.date >= addMonths(ix.cur, -1) + '-01')
    .sort((a, b) => b.date.localeCompare(a.date));
  const billingoOpen = open.filter((e) => e.source === 'billingo' || navByPlan.has(e.id));
  const sum = (es: Entry[]) => es.reduce((s, e) => s + e.amount, 0);
  const sumAbs = (es: Entry[]) => es.reduce((s, e) => s + Math.abs(e.amount), 0);
  const money = (v: number) => (side === 'all' ? (v > 0 ? '+' : v < 0 ? '−' : '') + fmt(Math.abs(v)) : fmt(Math.abs(v)));
  const isLate = (e: Entry) => e.date < data.today && !e.tentative;
  const shown = open.filter((e) =>
    focus === 'open'
      ? !e.tentative
      : focus === 'overdue'
        ? isLate(e)
        : focus === 'billingo'
          ? e.source === 'billingo' || navByPlan.has(e.id)
          : focus === 'offers'
            ? !!e.tentative
            : true,
  );
  const FOCUS_LABEL = { all: '', open: 'Nyitott tételek', overdue: 'Lejárt határidejű', billingo: 'Kiállított számlák', offers: 'Ajánlatok' };
  const byMonth = new Map<string, Entry[]>();
  shown
    .sort((a, b) => a.date.localeCompare(b.date))
    .forEach((e) => {
      // a lejárt tételek is hónaponként (a határidő hónapja szerint), külön „Lejárt · hónap” fejléccel
      const k = e.date < data.today && !e.tentative ? 'overdue:' + ymOf(e.date) : ymOf(e.date);
      if (!byMonth.has(k)) byMonth.set(k, []);
      byMonth.get(k)!.push(e);
    });

  const sync = () => run(() => api('/api/sync', { body: {} }), 'Szinkron kész');

  return (
    <div style={{ padding: mobile ? '14px 16px 120px' : '28px 32px 120px', display: 'flex', flexDirection: 'column', gap: 16, maxWidth: 1180 }}>
      {!mobile && (
        <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', gap: 16, flexWrap: 'wrap' }}>
          <div>
            <div style={{ font: `600 12px ${FONT}`, letterSpacing: '.18em', textTransform: 'uppercase', color: C.blue, marginBottom: 8 }}>
              Bevétel · kiadás · Billingo · NAV
            </div>
            <h1 style={{ margin: 0, font: `700 30px/1.05 ${FONT_H}`, color: C.navy }}>Tervezett bevételek, kiadások</h1>
            <p style={{ margin: '10px 0 0', font: `400 15px/1.5 ${FONT}`, color: C.muted, maxWidth: '62ch' }}>
              Melyik tételt mikor fizetik nekünk, és mikor fizetjük mi. A dátumra kattintva módosíthatod a fizetési határidőt. A kiállított és befogadott
              számlák automatikusan a határidejükre kerülnek; a banki jóváhagyáskor a terv lezárul és tény lesz belőle.
            </p>
          </div>
          {canEdit && <SyncPill label="↻ Szinkron most" onRun={sync} />}
        </div>
      )}
      <Seg
        value={side}
        onChange={setSide}
        options={[
          ['all', 'Mind'],
          ['in', 'Bevételek'],
          ['out', 'Kiadások'],
        ]}
      />
      <div style={{ display: 'grid', gridTemplateColumns: `repeat(auto-fit,minmax(${mobile ? 150 : 190}px,1fr))`, gap: 12 }}>
        <Stat
          dark
          active={focus === 'open'}
          onClick={() => pickFocus('open')}
          label={`Nyitott · ${monthLong(ymOf(horizon)).replace(/^\d+\. /, '')} végéig`}
          value={money(sum(open.filter((e) => !e.tentative)))}
          sub={
            side === 'all'
              ? `be ${fmt(sumAbs(open.filter((e) => !e.tentative && !isOut(e))))} · ki ${fmt(sumAbs(open.filter((e) => !e.tentative && isOut(e))))}`
              : `${open.filter((e) => !e.tentative).length} tétel`
          }
        />
        <Stat
          active={focus === 'overdue'}
          onClick={() => pickFocus('overdue')}
          label={side === 'out' ? 'Lejárt, még nem fizettük ki' : side === 'in' ? 'Lejárt, még nem érkezett be' : 'Lejárt határidejű'}
          value={money(sum(overdue))}
          sub={`${overdue.length} tétel`}
          color={overdue.length ? C.neg : undefined}
        />
        <Stat
          active={focus === 'billingo'}
          onClick={() => pickFocus('billingo')}
          label="Kiállított / befogadott számlák (nyitott)"
          value={money(sum(billingoOpen))}
          sub={data.integrations.billingo ? `Billingo · ${stamp(data.settings.billingo_last_sync)}` : 'Billingo nincs bekötve'}
        />
        <Stat
          active={focus === 'offers'}
          onClick={() => pickFocus('offers')}
          label="Ajánlatok (nem biztos)"
          value={money(sum(open.filter((e) => e.tentative)))}
          sub={`${open.filter((e) => e.tentative).length} ajánlat`}
        />
      </div>
      <div ref={listRef} style={{ scrollMarginTop: 80 }} />
      {focus !== 'all' && (
        <button
          onClick={() => setFocus('all')}
          style={{
            alignSelf: 'flex-start',
            border: 0,
            borderRadius: 999,
            background: C.navy,
            color: '#fff',
            padding: '8px 14px',
            font: `600 13px ${FONT}`,
            cursor: 'pointer',
          }}
        >
          Szűrve: {FOCUS_LABEL[focus]} ({shown.length}) · mind mutatása ✕
        </button>
      )}
      <label style={{ display: 'flex', alignItems: 'center', gap: 8, font: `500 13px ${FONT}`, color: C.muted }}>
        <input type="checkbox" checked={showOffers} onChange={(e) => setShowOffers(e.target.checked)} style={{ accentColor: C.blue }} />
        Ajánlatok mutatása
      </label>

      {[...byMonth.entries()].map(([k, es]) => (
        <div key={k} style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', padding: '0 4px' }}>
            <span style={{ font: `700 13px ${FONT_H}`, color: k.startsWith('overdue:') ? C.neg : C.navy, letterSpacing: '.04em', textTransform: 'uppercase' }}>
              {k.startsWith('overdue:') ? `Lejárt · ${monthLong(k.slice(8))}` : monthLong(k)}
              <span style={{ color: C.muted, fontWeight: 600, letterSpacing: 0, textTransform: 'none' }}> · {es.length} tétel</span>
            </span>
            <span style={{ font: `700 14px ${FONT}`, color: C.navy, fontVariantNumeric: 'tabular-nums' }}>
              {side === 'all'
                ? `be ${fmt(sumAbs(es.filter((e) => !e.tentative && !isOut(e))))} · ki ${fmt(sumAbs(es.filter((e) => !e.tentative && isOut(e))))} Ft`
                : `${fmt(sumAbs(es.filter((e) => !e.tentative)))} Ft`}
            </span>
          </div>
          <div style={{ ...card, overflow: 'hidden' }}>
            {es.map((e, i) => {
              const doc = docByPlan.get(e.id);
              const nav = navByPlan.get(e.id);
              const out = isOut(e);
              const bs = doc?.payment_status ? BSTATUS[doc.payment_status] : null;
              const late = e.date < data.today && !e.tentative;
              const days = Math.round((Date.parse(data.today) - Date.parse(e.date)) / 86400000);
              return (
                <div
                  key={e.id}
                  onClick={() => onOpen?.(e)}
                  style={{
                    cursor: onOpen ? 'pointer' : undefined,
                    display: 'flex',
                    flexWrap: 'wrap',
                    alignItems: 'center',
                    gap: '8px 14px',
                    padding: '12px 14px',
                    borderTop: i ? `1px solid ${C.line3}` : 0,
                  }}
                >
                  <span
                    role="button"
                    title={canEdit ? 'Fizetési határidő módosítása' : undefined}
                    onClick={(ev) => {
                      if (!canEdit) return;
                      ev.stopPropagation();
                      setPickFor(e);
                    }}
                    style={{
                      cursor: canEdit ? 'pointer' : undefined,
                      outline: `1px dashed ${canEdit ? (late ? C.negLight : C.line2) : 'transparent'}`,
                      width: 46,
                      flex: 'none',
                      display: 'flex',
                      flexDirection: 'column',
                      alignItems: 'center',
                      lineHeight: 1.05,
                      padding: '6px 0',
                      borderRadius: 10,
                      background: late ? C.negBg : C.bg,
                    }}
                  >
                    <b style={{ font: `800 17px ${FONT_H}`, color: late ? C.neg : C.navy }}>{Number(e.date.slice(8))}</b>
                    <span style={{ font: `600 10px ${FONT}`, color: late ? C.neg : C.navy, textTransform: 'uppercase' }}>
                      {monthLabel(ymOf(e.date)).replace('.', '')}
                    </span>
                  </span>
                  <span style={{ flex: '1 1 200px', minWidth: 0, display: 'flex', flexDirection: 'column', gap: 4 }}>
                    {/* fent a partner, alatta a feladat / szolgáltatás */}
                    <PartnerLink
                      leaf={e.leaf_id}
                      style={{ font: `700 15px ${FONT}`, color: C.navy, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                    >
                      {ix.leafById[e.leaf_id]?.label || e.name}
                    </PartnerLink>
                    {withMonth(e, itemLabel(e.name, ix.leafById[e.leaf_id]?.label || '')) && (
                      <span
                        style={{ font: `500 13.5px ${FONT}`, color: C.ink, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', marginTop: -2 }}
                      >
                        {withMonth(e, itemLabel(e.name, ix.leafById[e.leaf_id]?.label || ''))}
                      </span>
                    )}
                    <span style={{ display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center' }}>
                      {doc && (
                        <Badge color={C.blueDark} bg={C.bg2}>
                          Billingo {doc.number}
                        </Badge>
                      )}
                      {bs && <Badge color={bs[1]}>{bs[0]}</Badge>}
                      {nav && (
                        <Badge color={C.blueDark} bg={C.bg2}>
                          NAV {nav.invoice_number}
                        </Badge>
                      )}
                      {side === 'all' && (
                        <Badge color={out ? C.neg : '#1E7A46'} bg={out ? C.negBg : '#E8F4EC'}>
                          {out ? 'kiadás' : 'bevétel'}
                        </Badge>
                      )}
                      {e.tentative ? (
                        <Badge color="#8A6D1C" bg="#FFF6DD">
                          ajánlat
                        </Badge>
                      ) : null}
                      {late && (
                        <Badge color={C.neg} bg={C.negBg}>
                          {days} napja lejárt
                        </Badge>
                      )}
                    </span>
                  </span>
                  <span style={{ font: `700 15px ${FONT_H}`, color: out ? C.neg : C.navy, fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }}>
                    {out ? '−' : ''}
                    {fmt(Math.abs(e.amount))} Ft
                  </span>
                  {canEdit && (
                    <span style={{ display: 'flex', gap: 6 }} onClick={(ev) => ev.stopPropagation()}>
                      {e.date <= data.today && (
                        <Pill
                          small
                          kind="dark"
                          title={`${out ? 'Kifizetve' : 'Beérkezett'} (kézi lezárás – banki jóváhagyásnál automatikus)`}
                          onClick={() => commit(markDone(data, [e.id], true), `${e.name}: ${out ? 'kifizetve' : 'beérkezett'} ✓`)}
                        >
                          ✓ {out ? 'Kifizetve' : 'Beérkezett'}
                        </Pill>
                      )}
                    </span>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      ))}
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
      {byMonth.size === 0 && (
        <div style={{ ...card, padding: 28, textAlign: 'center', color: C.muted, font: `500 14px ${FONT}` }}>
          Nincs nyitott tervezett {side === 'out' ? 'kiadás' : side === 'in' ? 'bevétel' : 'tétel'}.
        </div>
      )}

      <div style={{ ...card, overflow: 'hidden', display: focus === 'all' ? undefined : 'none' }}>
        <div style={{ padding: '14px 16px', font: `700 15px ${FONT_H}`, color: C.navy, borderBottom: `1px solid ${C.line}` }}>
          {side === 'out' ? 'Kifizetett kiadások' : side === 'in' ? 'Beérkezett bevételek' : 'Befolyt és kifizetett tételek'} (előző és aktuális hónap)
        </div>
        {received.length === 0 && <div style={{ padding: 18, color: C.muted, font: `500 13.5px ${FONT}` }}>Még nincs beérkezett tétel.</div>}
        {received.slice(0, 40).map((e) => (
          <div key={e.id} style={{ display: 'flex', gap: 12, alignItems: 'center', padding: '10px 16px', borderTop: `1px solid ${C.line3}` }}>
            <span style={{ font: `600 12.5px ${FONT}`, color: C.muted, width: 80 }}>{e.date.replace(/-/g, '.')}.</span>
            <span style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
              <span style={{ font: `600 13.5px ${FONT}`, color: C.navy, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{e.name}</span>
              <span style={{ font: `400 12px ${FONT}`, color: C.muted }}>
                <PartnerLink leaf={e.leaf_id}>{ix.leafById[e.leaf_id]?.label}</PartnerLink> ·{' '}
                {e.source === 'bank' ? 'bankból' : e.source === 'import' ? 'xls' : e.source === 'billingo' ? 'Billingo' : 'kézi'}
                <PlanDiff actual={e} plan={planOfActual.get(e.id)} sec={ix.sectionOf(e.leaf_id)} />
              </span>
            </span>
            <span style={{ font: `700 14px ${FONT}`, color: e.amount < 0 ? C.neg : C.blueDark, fontVariantNumeric: 'tabular-nums' }}>
              {e.amount < 0 ? '−' : '+'}
              {fmt(Math.abs(e.amount))}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

function Stat(p: { label: string; value: string; sub: string; dark?: boolean; color?: string; active?: boolean; onClick?: () => void }) {
  return (
    <button
      type="button"
      onClick={p.onClick}
      style={{
        ...(p.dark ? { background: C.navy2, border: 0 } : card),
        outline: p.active ? `3px solid ${C.blue}` : 'none',
        outlineOffset: 2,
        borderRadius: 14,
        padding: '16px 18px',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'flex-start',
        gap: 6,
        textAlign: 'left',
        cursor: 'pointer',
        width: '100%',
      }}
    >
      <span style={{ ...eyebrow, color: p.dark ? C.muted2 : C.muted }}>{p.label}</span>
      <span style={{ font: `800 22px/1 ${FONT_H}`, color: p.color || (p.dark ? '#fff' : C.navy), fontVariantNumeric: 'tabular-nums' }}>{p.value} Ft</span>
      <span style={{ font: `400 12.5px ${FONT}`, color: p.dark ? C.muted2 : C.muted }}>{p.sub} ›</span>
    </button>
  );
}

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
