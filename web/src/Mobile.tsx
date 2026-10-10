// Mobil nézet (iPhone): egy hónap, egy kéz – áttekintés, kategória, tervezett bevétel, bank, beállítások.
import { useMemo, useState } from 'react';
import { displayGroup } from '../../shared/categories';
import { actualBalanceAt, buildEstimates, fmt, fmtK, monthLabel, monthLong, monthRange, projection, ymOf, MSL } from '../../shared/model';
import type { Entry, Rep, Section } from '../../shared/types';
import { AlertsView, FlagBanner, useFlags } from './AlertsView';
import { useBack } from './back';
import { StatsHub } from './StatsHub';
import { partnerIdOf } from '../../shared/partners';
import { FilterChips, MonthList, rowVisible, useRowFilter } from './MonthList';
import { avgDelay, billingoDocFor, daysBetween, isDeviation, monthRows, type MonthRow } from '../../shared/monthrows';
import { api } from './api';
import { BankView } from './BankView';
import { FilterBar } from './Filters';
import { IncomeView } from './IncomeView';
import { REP, ruleDateFor, ruleOf, deleteEntries, genSeries, markDone, shiftEntries } from './logic';
import { addDays, addMonthsDate, dayDiff, mondayAfter, mondayOnOrAfter, payRuleLabel } from '../../shared/workdays';
import { LeafPicker } from './LeafPicker';
import { APP_VERSION } from './version';
import { SettingsView } from './SettingsView';
import { useStore } from './store';
import { C, DateField, FONT, FONT_H, ToastView, relTime } from './ui';

type Tab = 'home' | 'alerts' | 'stats' | 'cat' | 'income' | 'bank' | 'more';
type Sheet =
  | {
      kind: 'new';
      type: Section;
      amount: string;
      name: string;
      leaf: string | null;
      rep: Rep;
      count: number;
      date: string;
      /** konstrukció: egyszerű tétel · setup + havidíj · két részlet (pl. weboldal) */
      mode?: 'simple' | 'setup' | 'parts';
      tentative?: boolean;
      setup?: string;
      monthly?: string;
      mStart?: string;
      months?: number;
      p1?: string;
      p1d?: string;
      p2?: string;
      p2d?: string;
    }
  | { kind: 'detail'; planId: string | null; actualId: string | null }
  | { kind: 'item'; id: string; amount: string; date: string; name: string; leaf: string; section: Section; pick: boolean; all: boolean; back?: Sheet }
  | { kind: 'filters' };

export function Mobile({ onLogout }: { onLogout: () => void }) {
  const st = useStore();
  const { ix, data, filters, commit, toast, canEdit, run } = st;
  const [tab, setTab] = useState<Tab>(() => (new URLSearchParams(location.search).get('tab') === 'alerts' ? 'alerts' : 'home'));
  const flags = useFlags();
  const [partnerKey, setPartnerKey] = useState<string | null>(null);
  const openPartner = (leaf: string) => (setPartnerKey(partnerIdOf(ix.leafById[leaf]?.label || leaf)), setTab('stats'));
  const months = useMemo(() => monthRange(filters.from, filters.to).slice(0, 24), [filters.from, filters.to]);
  const [mSel, setM] = useState<string>(ix.cur);
  const m = months.includes(mSel) ? mSel : months.includes(ix.cur) ? ix.cur : months[0];
  const [catId, setCatId] = useState<string>(ix.groups[0]?.id || '');
  const [selMode, setSelMode] = useState(false);
  const [sel, setSel] = useState<Record<string, boolean>>({});
  const [sheet, setSheet] = useState<Sheet | null>(null);
  // visszalépés (jobbra húzás / böngésző vissza): lap → előző lap, kijelölés → ki, fül → Áttekintés
  useBack(tab !== 'home', () => (setPartnerKey(null), setTab('home')));
  useBack(selMode, () => (setSelMode(false), setSel({})));
  useBack(!!sheet, () => setSheet(sheet && sheet.kind === 'item' && sheet.back ? sheet.back : null));
  const isPast = m < ix.cur;

  // egyenlegek hónaponként
  const balances = useMemo(() => {
    const to = months[months.length - 1];
    const est = filters.estimate ? buildEstimates(ix, to > ix.cur ? to : ix.cur) : new Map();
    const proj = projection(ix, filters, to > ix.cur ? to : ix.cur, est);
    const net = new Map<string, number>();
    const inc = new Map<string, number>();
    months.forEach((ym) => {
      let n = 0,
        i = 0;
      const add = (map: Map<string, Map<string, number>>) => {
        for (const [leaf, mm] of map) {
          const v = mm.get(ym) || 0;
          n += v;
          if (ix.sectionOf(leaf) === 'in') i += v;
        }
      };
      if (ym < ix.cur) add(ix.actual);
      else {
        if (ym === ix.cur) add(ix.actual);
        add(ix.openPlan);
        if (filters.includeOffers) add(ix.offer);
        if (filters.estimate && ym > ix.cur) add(est);
      }
      net.set(ym, n);
      inc.set(ym, i);
    });
    return { bal: new Map(months.map((ym) => [ym, ym < ix.cur ? actualBalanceAt(ix, ym) : (proj.get(ym) ?? ix.anchor)])), net, inc };
  }, [ix, filters, months]);

  const inM = (e: Entry) => ymOf(e.date) === m;
  const visibleEntry = (e: Entry) =>
    isPast ? e.kind === 'actual' : (e.kind === 'plan' && (filters.includeOffers || !e.tentative)) || (m === ix.cur && e.kind === 'actual' && !e.link_id);
  const sections = (['in', 'out'] as Section[])
    .filter((s) => filters.section === 'all' || filters.section === s)
    .map((s) => {
      let tot = 0;
      const groups = ix.groups
        .filter((g) => g.section === s)
        .map((g) => {
          const ids = new Set(ix.leaves.filter((l) => l.group_id === g.id).map((l) => l.id));
          const es = data.entries.filter((e) => inM(e) && ids.has(e.leaf_id) && visibleEntry(e));
          const sign = s === 'in' ? 1 : -1;
          const plan = es.reduce((a, e) => a + e.amount * sign, 0);
          const done = es.filter((e) => e.kind === 'actual' || e.done).reduce((a, e) => a + e.amount * sign, 0);
          tot += plan;
          return { g, plan, done, n: es.length, open: es.filter((e) => e.kind === 'plan' && !e.done).length };
        })
        .filter((x) => x.n > 0);
      return { s, tot, groups };
    })
    .filter((x) => x.groups.length);

  const newTx = data.bankTx.filter((t) => t.status === 'new').length;
  const maxNet = Math.max(...months.map((ym) => Math.abs(balances.net.get(ym) || 0)), 1);
  /** havi eredmény a bevétel %-ában (null, ha nincs bevétel) */
  const margin = (ym: string) => {
    const i = balances.inc.get(ym) || 0;
    return i > 0 ? Math.round(((balances.net.get(ym) || 0) / i) * 100) : null;
  };
  const G = ix.groupById[catId];
  const gIds = new Set(ix.leaves.filter((l) => l.group_id === catId).map((l) => l.id));
  const [rowFilter, setRowFilter] = useRowFilter();
  // a kategória tételei + az azonos oldal (bevétel / kiadás) többi kategóriájában lévő ajánlatok (pl. „Ajánlatok” csoport ügyfelei)
  const allRows = useMemo(() => {
    const own = monthRows(data.entries, m, gIds, data.today);
    const sec = G?.section;
    const others = new Set(ix.leaves.filter((l) => !gIds.has(l.id) && ix.sectionOf(l.id) === sec).map((l) => l.id));
    const offers = monthRows(data.entries, m, others, data.today).filter((r) => r.kind === 'offer');
    return [...own, ...offers].sort((a, b) => a.date.localeCompare(b.date));
  }, [data.entries, m, catId, data.today, ix]);
  const rows = allRows.filter((r) => rowVisible(r, rowFilter));
  const rowCounts = {
    actual: allRows.filter((r) => r.completed).length,
    plan: allRows.filter((r) => !r.completed && r.kind === 'plan').length,
    offer: allRows.filter((r) => r.kind === 'offer').length,
  };
  const openDetail = (r: MonthRow) => setSheet({ kind: 'detail', planId: r.plan?.id ?? null, actualId: r.actual?.id ?? null });
  const gSign = G?.section === 'in' ? 1 : -1;
  const catDeleted = (data.deleted || []).filter((d) => inM(d) && gIds.has(d.leaf_id));
  const selIds = Object.keys(sel).filter((k) => sel[k]);

  const openNew = () =>
    setSheet({ kind: 'new', type: 'in', amount: '', name: '', leaf: null, rep: 'once', count: 12, date: m > ix.cur ? m + '-10' : data.today });
  const dark = tab === 'home';

  return (
    <div style={{ minHeight: '100dvh', background: C.bg, display: 'flex', flexDirection: 'column' }}>
      <div style={{ height: 'env(safe-area-inset-top)', background: dark ? C.navy : '#fff' }} />
      <div style={{ flex: 1, paddingBottom: 96 }}>
        {tab === 'home' && (
          <>
            <div style={{ background: C.navy, color: '#fff', padding: '10px 20px 22px', display: 'flex', flexDirection: 'column', gap: 14 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
                <span style={{ font: `700 17px ${FONT_H}` }}>
                  Cashflow <b style={{ color: C.blue2 }}>tervező</b>{' '}
                  <small style={{ font: `600 11px ${FONT}`, color: C.muted2, letterSpacing: '.02em' }}>{APP_VERSION}</small>
                </span>
                <button
                  onClick={() => setTab('bank')}
                  style={{
                    height: 36,
                    border: 0,
                    borderRadius: 999,
                    background: C.navy3,
                    color: '#fff',
                    padding: '0 12px',
                    font: `600 12.5px ${FONT}`,
                    display: 'flex',
                    alignItems: 'center',
                    gap: 6,
                    whiteSpace: 'nowrap',
                  }}
                >
                  <i style={{ width: 7, height: 7, borderRadius: '50%', background: C.blue2 }} />
                  {ix.anchorSource === 'bank' ? 'Bank' : 'Számított'} · {relTime(Math.max(0, ...data.accounts.map((a) => a.last_sync || 0)))}
                </button>
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                <span style={{ font: `600 11px ${FONT}`, letterSpacing: '.14em', textTransform: 'uppercase', color: C.muted2 }}>
                  {m === ix.cur
                    ? `Mai egyenleg: ${fmt(ix.anchor)} Ft · ${monthLabel(m)} várható záró`
                    : `${monthLong(m)} végén${m > ix.cur ? ' (előrejelzés)' : ''}`}
                </span>
                <span
                  style={{
                    font: `800 34px/1.05 ${FONT_H}`,
                    letterSpacing: '-.02em',
                    fontVariantNumeric: 'tabular-nums',
                    color: (balances.bal.get(m) || 0) < 0 ? C.negLight : '#fff',
                  }}
                >
                  {fmt(balances.bal.get(m) || 0)} <small style={{ font: `600 16px ${FONT}`, color: C.muted2 }}>Ft</small>
                </span>
                <span style={{ font: `500 13px ${FONT}`, color: C.muted2 }}>
                  Havi eredmény:{' '}
                  <b style={{ color: (balances.net.get(m) || 0) < 0 ? '#FF8A7A' : '#4CC38A' }}>
                    {(balances.net.get(m) || 0) > 0 ? '+' : ''}
                    {fmt(balances.net.get(m) || 0)} Ft
                  </b>
                  {margin(m) !== null && (
                    <b style={{ color: (balances.net.get(m) || 0) < 0 ? '#FF8A7A' : '#4CC38A' }}>
                      {' '}
                      ({(margin(m) || 0) > 0 ? '+' : ''}
                      {margin(m)}% a bevételhez)
                    </b>
                  )}
                </span>
              </div>
              <div style={{ display: 'flex', gap: 4, alignItems: 'stretch', height: 128, overflowX: 'auto', scrollbarWidth: 'none' }}>
                {months.map((ym) => {
                  // havi eredmény (bevétel − kiadás): zöld plusz, piros mínusz; alatta az eredmény a bevétel %-ában
                  const v = balances.net.get(ym) || 0;
                  const pc = margin(ym);
                  const h = Math.max(v ? 4 : 0, Math.round((Math.abs(v) / maxNet) * 44));
                  const col = v >= 0 ? '#4CC38A' : '#FF8A7A';
                  return (
                    <button
                      key={ym}
                      onClick={() => setM(ym)}
                      style={{
                        flex: `1 0 ${months.length > 10 ? 34 : 0}px`,
                        height: '100%',
                        border: 0,
                        borderRadius: 8,
                        background: ym === m ? 'rgba(255,255,255,.08)' : 'transparent',
                        padding: '2px 0',
                        display: 'flex',
                        flexDirection: 'column',
                        alignItems: 'center',
                        gap: 3,
                      }}
                    >
                      <div style={{ position: 'relative', width: '100%', flex: 1 }}>
                        <div style={{ position: 'absolute', left: 0, right: 0, top: '50%', borderTop: '1px solid rgba(255,255,255,.18)' }} />
                        <div
                          style={{
                            position: 'absolute',
                            left: '18%',
                            right: '18%',
                            height: h,
                            top: v >= 0 ? `calc(50% - ${h}px)` : '50%',
                            borderRadius: v >= 0 ? '4px 4px 0 0' : '0 0 4px 4px',
                            background: col,
                            opacity: ym > ix.cur ? 0.55 : 1,
                          }}
                        />
                      </div>
                      <span style={{ font: `700 9.5px ${FONT}`, color: pc === null ? C.muted2 : col, whiteSpace: 'nowrap' }}>
                        {pc === null ? '–' : `${pc > 0 ? '+' : ''}${pc}%`}
                      </span>
                      <span style={{ font: `600 10.5px ${FONT}`, color: ym === m ? '#fff' : C.muted2 }}>{monthLabel(ym).replace('.', '')}</span>
                    </button>
                  );
                })}
              </div>
              <button
                onClick={() => setSheet({ kind: 'filters' })}
                style={{
                  alignSelf: 'flex-start',
                  border: `1px solid ${C.navy3}`,
                  background: 'transparent',
                  color: C.muted2,
                  borderRadius: 999,
                  padding: '6px 12px',
                  font: `600 12px ${FONT}`,
                }}
              >
                Szűrők: {filters.mode === 'auto' ? 'tény + terv' : filters.mode === 'actual' ? 'tény' : 'terv'}
                {filters.estimate ? ' · becslés' : ''}
                {filters.includeOffers ? ' · ajánlatok' : ''} ▾
              </button>
            </div>
            {flags.length > 0 && <FlagBanner mobile n={flags.length} kinds={flags.map((f) => f.kind)} onClick={() => setTab('alerts')} />}
            {newTx > 0 && (
              <button
                onClick={() => setTab('bank')}
                style={{
                  margin: '14px 16px 0',
                  width: 'calc(100% - 32px)',
                  border: `1px solid ${C.line2}`,
                  background: C.bg2,
                  borderRadius: 14,
                  padding: '14px 16px',
                  display: 'flex',
                  alignItems: 'center',
                  gap: 12,
                  textAlign: 'left',
                }}
              >
                <span
                  style={{
                    minWidth: 30,
                    height: 30,
                    borderRadius: 999,
                    background: C.blue,
                    color: '#fff',
                    font: `700 13px ${FONT}`,
                    display: 'grid',
                    placeItems: 'center',
                  }}
                >
                  {newTx}
                </span>
                <span style={{ flex: 1, display: 'flex', flexDirection: 'column' }}>
                  <b style={{ font: `600 14px ${FONT}`, color: C.navy }}>Új banki tétel vár jóváhagyásra</b>
                  <span style={{ font: `400 12.5px ${FONT}`, color: C.muted }}>Kategória és párosítás kész</span>
                </span>
                <span style={{ font: `600 18px ${FONT}`, color: C.blueDark }}>›</span>
              </button>
            )}
            <div style={{ padding: '18px 16px 8px', display: 'flex', flexDirection: 'column', gap: 18 }}>
              {sections.length === 0 && (
                <div
                  style={{
                    background: '#fff',
                    border: `1px dashed ${C.line2}`,
                    borderRadius: 14,
                    padding: '28px 16px',
                    textAlign: 'center',
                    font: `500 14px ${FONT}`,
                    color: C.muted,
                  }}
                >
                  Ebben a hónapban nincs tétel.
                </div>
              )}
              {sections.map(({ s, tot, groups }) => (
                <div key={s} style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', padding: '0 4px' }}>
                    <span style={{ font: `700 13px ${FONT_H}`, color: C.navy, letterSpacing: '.04em', textTransform: 'uppercase' }}>
                      {s === 'in' ? 'Bevétel' : 'Kiadás'} {isPast ? '· tény' : ''}
                    </span>
                    <span style={{ font: `700 14px ${FONT}`, color: C.navy, fontVariantNumeric: 'tabular-nums' }}>
                      {s === 'in' ? '+' : '−'}
                      {fmt(tot)}
                    </span>
                  </div>
                  <div style={{ background: '#fff', border: `1px solid ${C.line}`, borderRadius: 14, overflow: 'hidden' }}>
                    {groups.map(({ g, plan, done, n, open }, gi) => (
                      <button
                        key={g.id}
                        onClick={() => {
                          setCatId(g.id);
                          setSel({});
                          setSelMode(false);
                          setTab('cat');
                        }}
                        style={{
                          width: '100%',
                          minHeight: 60,
                          border: 0,
                          borderTop: gi ? `1px solid ${C.line3}` : 0,
                          background: '#fff',
                          padding: '10px 14px',
                          display: 'flex',
                          flexDirection: 'column',
                          gap: 6,
                          textAlign: 'left',
                        }}
                      >
                        <span style={{ width: '100%', display: 'flex', alignItems: 'center', gap: 8 }}>
                          <span style={{ flex: 1, font: `600 14.5px ${FONT}`, color: C.ink }}>{displayGroup(g.label).replace(/^\d+ · /, '')}</span>
                          <span style={{ font: `600 14.5px ${FONT}`, color: C.navy, fontVariantNumeric: 'tabular-nums' }}>{fmt(plan)}</span>
                          <span style={{ font: `600 16px ${FONT}`, color: C.faint }}>›</span>
                        </span>
                        {!isPast && (
                          <span style={{ width: '100%', display: 'flex', alignItems: 'center', gap: 8 }}>
                            <span style={{ flex: 1, height: 5, borderRadius: 999, background: '#EEF2F7', overflow: 'hidden' }}>
                              <i
                                style={{
                                  display: 'block',
                                  height: '100%',
                                  width: `${plan ? Math.min(100, Math.round((done / plan) * 100)) : 0}%`,
                                  background: C.blue,
                                  borderRadius: 999,
                                }}
                              />
                            </span>
                            <span style={{ font: `500 12px ${FONT}`, color: C.muted, minWidth: 96, textAlign: 'right' }}>
                              {done ? fmt(done) + ' teljesült' : open + ' tétel nyitott'}
                            </span>
                          </span>
                        )}
                        {isPast && <span style={{ font: `500 12px ${FONT}`, color: C.muted }}>{n} tétel</span>}
                      </button>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </>
        )}

        {tab === 'cat' && G && (
          <>
            <div style={{ background: '#fff', borderBottom: `1px solid ${C.line}`, padding: '4px 8px 12px', position: 'sticky', top: 0, zIndex: 3 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                <button
                  onClick={() => setTab('home')}
                  style={{ width: 44, height: 44, border: 0, background: 'transparent', font: `500 26px ${FONT}`, color: C.navy }}
                >
                  ‹
                </button>
                <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0 }}>
                  <span style={{ font: `600 11px ${FONT}`, letterSpacing: '.14em', textTransform: 'uppercase', color: C.blue }}>
                    {G.section === 'in' ? 'Bevétel' : 'Kiadás'}
                  </span>
                  <select
                    value={catId}
                    onChange={(e) => setCatId(e.target.value)}
                    style={{ border: 0, background: 'transparent', font: `700 18px ${FONT_H}`, color: C.navy, padding: 0, maxWidth: '100%' }}
                  >
                    {ix.groups.map((g) => (
                      <option key={g.id} value={g.id}>
                        {displayGroup(g.label)}
                      </option>
                    ))}
                  </select>
                </div>
                {canEdit && !isPast && (
                  <button
                    onClick={() => (setSelMode(!selMode), setSel({}))}
                    style={{
                      height: 36,
                      border: `1.5px solid ${C.line2}`,
                      background: '#fff',
                      borderRadius: 999,
                      padding: '0 14px',
                      font: `600 13px ${FONT}`,
                      color: C.navy,
                      marginRight: 6,
                    }}
                  >
                    {selMode ? 'Kész' : 'Kijelölés'}
                  </button>
                )}
              </div>
              <div style={{ display: 'flex', gap: 6, overflowX: 'auto', padding: '8px 8px 0', scrollbarWidth: 'none' }}>
                {months.map((ym) => {
                  const sum = data.entries
                    .filter((e) => ymOf(e.date) === ym && gIds.has(e.leaf_id) && (ym < ix.cur ? e.kind === 'actual' : e.kind === 'plan' && !e.tentative))
                    .reduce((a, e) => a + e.amount * gSign, 0);
                  return (
                    <button
                      key={ym}
                      onClick={() => setM(ym)}
                      style={{
                        flex: 'none',
                        height: 40,
                        minWidth: 62,
                        borderRadius: 999,
                        border: `1px solid ${ym === m ? C.navy : C.line2}`,
                        background: ym === m ? C.navy : '#fff',
                        color: ym === m ? '#fff' : C.ink,
                        padding: '0 12px',
                        display: 'flex',
                        flexDirection: 'column',
                        alignItems: 'center',
                        justifyContent: 'center',
                        lineHeight: 1.1,
                      }}
                    >
                      <span style={{ font: `600 13px ${FONT}` }}>{monthLabel(ym)}</span>
                      <span style={{ font: `500 10.5px ${FONT}`, opacity: 0.75 }}>{sum ? fmtK(sum) : '–'}</span>
                    </button>
                  );
                })}
              </div>
            </div>
            <div style={{ padding: '14px 16px', display: 'flex', flexDirection: 'column', gap: 10 }}>
              <span style={{ font: `700 14px ${FONT_H}`, color: C.navy, padding: '0 4px' }}>
                {m.slice(0, 4)}. {MSL[Number(m.slice(5)) - 1]} · összesen: {fmt(rows.reduce((a, r) => a + r.amount * gSign, 0))} Ft
              </span>
              <FilterChips f={rowFilter} onChange={setRowFilter} counts={rowCounts} />
              {rows.length === 0 && (
                <div
                  style={{
                    background: '#fff',
                    border: `1px dashed ${C.line2}`,
                    borderRadius: 14,
                    padding: '28px 16px',
                    textAlign: 'center',
                    font: `500 14px ${FONT}`,
                    color: C.muted,
                  }}
                >
                  Ebben a hónapban nincs tétel{allRows.length ? ' a kiválasztott szűrővel' : ''}.
                </div>
              )}
              <MonthList
                rows={rows}
                sign={gSign}
                m={m}
                selMode={selMode}
                sel={sel}
                setSel={setSel}
                onOpenPlan={(e) => setSheet({ kind: 'detail', planId: e.id, actualId: null })}
                onDetail={openDetail}
                onToggleDone={(e) => commit(markDone(data, [e.id], !e.done), e.done ? 'Újra nyitott' : 'Kész ✓')}
                onPartner={openPartner}
              />
              {catDeleted.map((d) => (
                <div
                  key={'del' + d.rid}
                  style={{
                    border: `1.5px dashed ${C.line2}`,
                    borderRadius: 14,
                    padding: '12px 14px',
                    display: 'flex',
                    alignItems: 'center',
                    gap: 12,
                    background: 'transparent',
                  }}
                >
                  <span style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 3 }}>
                    <span
                      style={{
                        font: `600 15px ${FONT}`,
                        color: C.faint,
                        textDecoration: 'line-through',
                        whiteSpace: 'nowrap',
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                      }}
                    >
                      {d.name || ix.leafById[d.leaf_id]?.label}
                    </span>
                    <span style={{ font: `500 12px ${FONT}`, color: C.faint }}>
                      törölve · {Number(d.date.slice(8))}. · <s>{fmt(d.amount * gSign)} Ft</s>
                    </span>
                  </span>
                  {canEdit && (
                    <button
                      onClick={() => run(() => api('/api/trash/restore', { body: { rids: [d.rid] } }), `${d.name || 'Tétel'} visszaállítva`)}
                      style={{
                        height: 36,
                        border: `1.5px solid ${C.line2}`,
                        background: '#fff',
                        borderRadius: 999,
                        padding: '0 14px',
                        font: `600 13px ${FONT}`,
                        color: C.blueDark,
                      }}
                    >
                      ↺ Vissza
                    </button>
                  )}
                </div>
              ))}
            </div>
          </>
        )}

        {tab === 'stats' && (
          <>
            <MobileHeader title="Statisztika" sub="Partner" onBack={() => (setPartnerKey(null), setTab('home'))} />
            <div style={{ padding: '12px 16px 24px' }}>
              <StatsHub key={partnerKey || ''} mobile partnerKey={partnerKey} onPartnerBack={() => (setPartnerKey(null), setTab('home'))} />
            </div>
          </>
        )}
        {tab === 'alerts' && (
          <>
            <MobileHeader title="Riasztások" sub="Eltérések a havi tervtől" onBack={() => setTab('home')} />
            <AlertsView mobile />
          </>
        )}
        {tab === 'income' && (
          <>
            <MobileHeader title="Tervezett bevétel" sub="Billingo számlák" onBack={() => setTab('home')} />
            <IncomeView
              mobile
              onOpen={(e) => setSheet({ kind: 'detail', planId: e.kind === 'plan' ? e.id : null, actualId: e.kind === 'actual' ? e.id : null })}
            />
          </>
        )}
        {tab === 'bank' && (
          <>
            <MobileHeader title="Bankszinkron" sub={data.accounts.map((a) => a.bank_name).join(' · ') || 'Bank'} onBack={() => setTab('home')} />
            <BankView mobile />
          </>
        )}
        {tab === 'more' && (
          <>
            <MobileHeader title="Beállítások" sub={data.me.name} onBack={() => setTab('home')} />
            <SettingsView mobile onLogout={onLogout} />
          </>
        )}
      </div>

      {tab === 'cat' && selMode && selIds.length > 0 && (
        <div
          style={{
            position: 'fixed',
            left: 12,
            right: 12,
            bottom: 'calc(env(safe-area-inset-bottom) + 92px)',
            zIndex: 8,
            background: C.navy,
            color: '#fff',
            borderRadius: 20,
            padding: 12,
            display: 'flex',
            flexDirection: 'column',
            gap: 10,
            boxShadow: '0 24px 48px rgba(0,32,64,.3)',
          }}
        >
          <div style={{ display: 'flex', justifyContent: 'space-between', font: `600 13.5px ${FONT}`, padding: '0 4px' }}>
            <span>{selIds.length} tétel kijelölve</span>
            <span style={{ color: C.muted2 }}>{fmt(data.entries.filter((e) => sel[e.id]).reduce((a, e) => a + e.amount * gSign, 0))} Ft</span>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr', gap: 6 }}>
            <button
              onClick={() => (commit(markDone(data, selIds, true), `${selIds.length} tétel kész ✓`), setSel({}), setSelMode(false))}
              style={mBtn('#fff', C.navy)}
            >
              ✓ Késznek jelöl
            </button>
            <button
              onClick={() => (commit(deleteEntries(data, selIds), `${selIds.length} tétel törölve`), setSel({}), setSelMode(false))}
              style={mBtn(C.navy3, C.negLight)}
            >
              Törlés
            </button>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: 6 }}>
            {[-1, 1, 2, 3].map((n) => (
              <button
                key={n}
                onClick={() => (commit(shiftEntries(data, selIds, n), `${selIds.length} tétel → ${n > 0 ? '+' : ''}${n} hónap`), setSel({}), setSelMode(false))}
                style={mBtn(n < 0 ? C.navy3 : C.blue, '#fff')}
              >
                {n > 0 ? '+' : '−'}
                {Math.abs(n)} hó
              </button>
            ))}
          </div>
        </div>
      )}

      <div
        style={{
          position: 'fixed',
          left: 0,
          right: 0,
          bottom: 0,
          zIndex: 7,
          paddingBottom: 'env(safe-area-inset-bottom)',
          background: '#fff',
          borderTop: `1px solid ${C.line}`,
        }}
      >
        <div style={{ height: 76, display: 'grid', gridTemplateColumns: '1fr 1fr 80px 1fr 1fr', alignItems: 'start', paddingTop: 8 }}>
          <TabBtn active={tab === 'home' || tab === 'cat'} label="Áttekintés" onClick={() => setTab('home')} />
          <TabBtn active={tab === 'income'} label="Bevétel" onClick={() => setTab('income')} />
          <div style={{ display: 'flex', justifyContent: 'center' }}>
            {canEdit && (
              <button
                aria-label="Új tétel"
                onClick={openNew}
                style={{
                  width: 58,
                  height: 58,
                  marginTop: -22,
                  borderRadius: 999,
                  border: `4px solid ${C.bg}`,
                  background: C.blue,
                  color: '#fff',
                  font: `500 30px/1 ${FONT}`,
                  boxShadow: '0 10px 24px rgba(40,127,170,.35)',
                }}
              >
                +
              </button>
            )}
          </div>
          <TabBtn active={tab === 'bank'} label={'Bank' + (newTx ? ` (${newTx})` : '')} onClick={() => setTab('bank')} />
          <TabBtn active={tab === 'more'} label="Beállítás" onClick={() => setTab('more')} />
        </div>
      </div>

      {sheet && <SheetView sheet={sheet} setSheet={setSheet} onSaved={(ym) => setM(ym)} onPartner={(leaf) => (setSheet(null), openPartner(leaf))} />}
      {toast && <ToastView {...toast} mobile />}
    </div>
  );
}

const mBtn = (bg: string, fg: string): React.CSSProperties => ({
  height: 44,
  border: 0,
  borderRadius: 12,
  background: bg,
  color: fg,
  font: `600 14px ${FONT}`,
});

function TabBtn({ active, label, onClick }: { active: boolean; label: string; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      style={{
        height: 48,
        border: 0,
        background: 'transparent',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 3,
        color: active ? C.navy : C.faint,
      }}
    >
      <i style={{ width: 22, height: 4, borderRadius: 999, background: active ? C.blue : 'transparent' }} />
      <span style={{ font: `600 12px ${FONT}` }}>{label}</span>
    </button>
  );
}

function MobileHeader({ title, sub, onBack }: { title: string; sub: string; onBack: () => void }) {
  return (
    <div
      style={{
        background: '#fff',
        borderBottom: `1px solid ${C.line}`,
        padding: '4px 8px 12px',
        display: 'flex',
        alignItems: 'center',
        gap: 4,
        position: 'sticky',
        top: 0,
        zIndex: 3,
      }}
    >
      <button onClick={onBack} style={{ width: 44, height: 44, border: 0, background: 'transparent', font: `500 26px ${FONT}`, color: C.navy }}>
        ‹
      </button>
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column' }}>
        <span style={{ font: `600 11px ${FONT}`, letterSpacing: '.14em', textTransform: 'uppercase', color: C.blue }}>{sub}</span>
        <span style={{ font: `700 18px ${FONT_H}`, color: C.navy }}>{title}</span>
      </div>
    </div>
  );
}

function SheetView({
  sheet,
  setSheet,
  onSaved,
  onPartner,
}: {
  sheet: Sheet;
  setSheet: (s: Sheet | null) => void;
  onSaved: (ym: string) => void;
  onPartner: (leaf: string) => void;
}) {
  const { ix, data, commit } = useStore();
  const close = () => setSheet(null);
  let body: React.ReactNode = null;

  if (sheet.kind === 'filters') {
    body = (
      <>
        <span style={{ font: `700 18px ${FONT_H}`, color: C.navy }}>Szűrők</span>
        <FilterBar compact />
        <button onClick={close} style={{ height: 50, border: 0, borderRadius: 999, background: C.navy, color: '#fff', font: `600 15px ${FONT}` }}>
          Kész
        </button>
      </>
    );
  }

  if (sheet.kind === 'new') {
    const f = sheet;
    const set = (p: Partial<typeof f>) => setSheet({ ...f, ...p });
    const amt = parseInt(f.amount || '0');
    const press = (k: string) => {
      let a = f.amount || '';
      if (k === '⌫') a = a.slice(0, -1);
      else if (k === '000') a = a ? a + '000' : '';
      else a = (a + k).replace(/^0+/, '');
      if (a.length > 11) return;
      set({ amount: a });
    };
    const step = f.rep === 'quarterly' ? 3 : 1;
    const n = f.rep === 'once' ? 1 : Math.ceil(f.count / step);
    const mode = f.type === 'in' ? f.mode || 'simple' : 'simple';
    // az „Ajánlatok” csoport ügyfelénél alapból ajánlat
    const offer = f.tentative ?? (!!f.leaf && /aj[aá]nlat/i.test(ix.groupById[ix.leafById[f.leaf]?.group_id]?.label || ''));
    const num = (v?: string) => parseInt(v || '0') || 0;
    const money = (v: string | undefined, on: (v: string) => void) => (
      <div
        style={{
          flex: 1,
          minWidth: 0,
          display: 'flex',
          alignItems: 'center',
          border: `1.5px solid ${C.line2}`,
          borderRadius: 12,
          padding: '0 12px',
          height: 46,
        }}
      >
        <input
          value={num(v) ? fmt(num(v)) : ''}
          onChange={(e) => on(e.target.value.replace(/\D/g, '').slice(0, 11))}
          inputMode="numeric"
          placeholder="0"
          style={{ flex: 1, minWidth: 0, border: 0, outline: 0, font: `700 17px ${FONT_H}`, color: C.navy, background: 'transparent' }}
        />
        <span style={{ font: `600 13px ${FONT}`, color: C.muted }}>Ft</span>
      </div>
    );
    const count =
      mode === 'setup' ? (num(f.setup) ? 1 : 0) + (num(f.monthly) ? f.months || 12 : 0) : mode === 'parts' ? (num(f.p1) ? 1 : 0) + (num(f.p2) ? 1 : 0) : n;
    const ready = !!f.leaf && (mode === 'simple' ? !!amt : count > 0);
    const saveComposite = () => {
      if (!ready || !f.leaf) return;
      const base = f.name.trim() || ix.leafById[f.leaf].label;
      const parts: { name: string; amount: number; date: string; rep: Rep; count: number }[] = [];
      if (mode === 'setup') {
        if (num(f.setup)) parts.push({ name: `${base} – setup`, amount: num(f.setup), date: f.date, rep: 'once', count: 1 });
        const ms = f.mStart || f.date;
        if (num(f.monthly)) parts.push({ name: `${base} – havidíj`, amount: num(f.monthly), date: ms, rep: 'monthly', count: f.months || 12 });
      } else {
        if (num(f.p1)) parts.push({ name: `${base} – 1. részlet`, amount: num(f.p1), date: f.p1d || f.date, rep: 'once', count: 1 });
        if (num(f.p2)) parts.push({ name: `${base} – 2. részlet`, amount: num(f.p2), date: f.p2d || addMonthsDate(f.p1d || f.date, 1), rep: 'once', count: 1 });
      }
      const batch = { upsert: [] as Entry[], series: [] as NonNullable<ReturnType<typeof genSeries>['series']> };
      for (const p of parts) {
        const b = genSeries({
          leaf: f.leaf,
          section: f.type,
          name: p.name,
          amount: p.amount,
          startYm: ymOf(p.date),
          count: p.count,
          rep: p.rep,
          day: Number(p.date.slice(8)),
          tentative: offer,
        });
        batch.upsert.push(...(b.upsert || []));
        batch.series.push(...(b.series || []));
      }
      commit(batch, `${batch.upsert.length} tétel${offer ? ' (ajánlat)' : ''} → ${ix.leafById[f.leaf].label}`);
      onSaved(ymOf(parts[0].date));
      close();
    };
    const lbl: React.CSSProperties = { font: `600 11px ${FONT}`, letterSpacing: '.12em', textTransform: 'uppercase', color: C.muted };
    const seg = (on: boolean): React.CSSProperties => ({
      flex: 1,
      height: 38,
      border: 0,
      borderRadius: 9,
      font: `600 13.5px ${FONT}`,
      background: on ? C.navy : 'transparent',
      color: on ? '#fff' : C.muted,
    });
    body = (
      <>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
          <span style={{ font: `700 18px ${FONT_H}`, color: C.navy }}>Új tervezett tétel</span>
          <div style={{ display: 'flex', background: C.bg, border: `1px solid ${C.line}`, borderRadius: 999, padding: 3, gap: 2 }}>
            {(
              [
                ['in', 'Bevétel'],
                ['out', 'Kiadás'],
              ] as [Section, string][]
            ).map(([v, l]) => (
              <button
                key={v}
                onClick={() => set({ type: v, leaf: null })}
                style={{
                  height: 34,
                  border: 0,
                  borderRadius: 999,
                  padding: '0 14px',
                  font: `600 13px ${FONT}`,
                  background: f.type === v ? C.navy : 'transparent',
                  color: f.type === v ? '#fff' : C.muted,
                }}
              >
                {l}
              </button>
            ))}
          </div>
        </div>
        {f.type === 'in' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <span style={lbl}>Konstrukció</span>
            <div style={{ display: 'flex', background: C.bg, border: `1px solid ${C.line}`, borderRadius: 12, padding: 3, gap: 2 }}>
              {(
                [
                  ['simple', 'Egy tétel'],
                  ['setup', 'Setup + havidíj'],
                  ['parts', '1. + 2. részlet'],
                ] as ['simple' | 'setup' | 'parts', string][]
              ).map(([v, l]) => (
                <button key={v} onClick={() => set({ mode: v })} style={{ ...seg(mode === v), fontSize: 12.5 }}>
                  {l}
                </button>
              ))}
            </div>
            <button
              onClick={() => set({ tentative: !offer })}
              style={{
                alignSelf: 'flex-start',
                height: 36,
                borderRadius: 999,
                padding: '0 14px',
                border: `1.5px solid ${offer ? '#C9A227' : C.line2}`,
                background: offer ? '#FFF6DE' : '#fff',
                color: offer ? '#8A6D1C' : C.muted,
                font: `600 13px ${FONT}`,
              }}
            >
              {offer ? '✓ ' : ''}Ajánlat (még nem biztos)
            </button>
          </div>
        )}
        {mode === 'simple' && (
          <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'center', gap: 8, paddingTop: 2 }}>
            <span style={{ font: `800 40px ${FONT_H}`, color: amt ? C.navy : C.faint, letterSpacing: '-.02em', fontVariantNumeric: 'tabular-nums' }}>
              {amt ? fmt(amt) : '0'}
            </span>
            <span style={{ font: `600 16px ${FONT}`, color: C.muted }}>Ft</span>
          </div>
        )}
        <input
          value={f.name}
          onChange={(e) => set({ name: e.target.value })}
          placeholder="Megnevezés (nem kötelező)"
          style={{ height: 46, border: `1px solid ${C.line2}`, borderRadius: 12, padding: '0 14px', font: `500 16px ${FONT}`, color: C.ink }}
        />
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <span style={lbl}>{f.type === 'in' ? 'Ügyfél / kategória' : 'Kategória'}</span>
          <LeafPicker key={f.type} big section={f.type} value={f.leaf} onChange={(id) => set({ leaf: id, date: ruleDateFor(ix, id, f.date, data.today) })} />
        </div>
        {mode === 'setup' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            <span style={lbl}>Egyszeri díj – setup</span>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              {money(f.setup, (v) => set({ setup: v }))}
              <DateField value={f.date} min={ix.cur + '-01'} onChange={(v) => set({ date: v })} style={{ flex: '0 0 170px' }} />
            </div>
            <span style={lbl}>Havidíj</span>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              {money(f.monthly, (v) => set({ monthly: v }))}
              <DateField value={f.mStart || f.date} min={ix.cur + '-01'} onChange={(v) => set({ mStart: v })} style={{ flex: '0 0 170px' }} />
            </div>
            <span style={lbl}>Hány hónapig tart?</span>
            <div style={{ display: 'flex', background: C.bg, border: `1px solid ${C.line}`, borderRadius: 12, padding: 3, gap: 2 }}>
              {[3, 6, 12, 24].map((c) => (
                <button key={c} onClick={() => set({ months: c })} style={seg((f.months || 12) === c)}>
                  {c} hó
                </button>
              ))}
            </div>
          </div>
        )}
        {mode === 'parts' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            <span style={lbl}>1. részlet (pl. előleg)</span>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              {money(f.p1, (v) => set({ p1: v }))}
              <DateField value={f.p1d || f.date} min={ix.cur + '-01'} onChange={(v) => set({ p1d: v })} style={{ flex: '0 0 170px' }} />
            </div>
            <span style={lbl}>2. részlet (pl. átadáskor)</span>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              {money(f.p2, (v) => set({ p2: v }))}
              <DateField
                value={f.p2d || addMonthsDate(f.p1d || f.date, 1)}
                min={ix.cur + '-01'}
                onChange={(v) => set({ p2d: v })}
                style={{ flex: '0 0 170px' }}
              />
            </div>
          </div>
        )}
        {mode === 'simple' && (
          <>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              <span style={lbl}>Ütemezés</span>
              <div style={{ display: 'flex', background: C.bg, border: `1px solid ${C.line}`, borderRadius: 12, padding: 3, gap: 2 }}>
                {(
                  [
                    ['once', 'Egyszeri'],
                    ['monthly', 'Havi'],
                    ['quarterly', 'Negyedéves'],
                  ] as [Rep, string][]
                ).map(([v, l]) => (
                  <button key={v} onClick={() => set({ rep: v })} style={seg(f.rep === v)}>
                    {l}
                  </button>
                ))}
              </div>
              {f.rep !== 'once' && (
                <div style={{ display: 'flex', background: C.bg, border: `1px solid ${C.line}`, borderRadius: 12, padding: 3, gap: 2 }}>
                  {[3, 6, 12, 24].map((c) => (
                    <button key={c} onClick={() => set({ count: c })} style={seg(f.count === c)}>
                      {c} hó
                    </button>
                  ))}
                </div>
              )}
            </div>
            <label style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <span style={{ ...lbl, minWidth: 92 }}>{f.rep === 'once' ? 'Dátum' : 'Első dátum'}</span>
              <DateField big value={f.date} min={ix.cur + '-01'} onChange={(v) => set({ date: v })} style={{ flex: 1 }} />
            </label>
            <span style={{ font: `500 12.5px ${FONT}`, color: C.muted, marginTop: -6 }}>
              {ruleOf(ix, f.leaf) ? `Fizetés: ${payRuleLabel(ruleOf(ix, f.leaf))} (szabály) · ` : ''}
              {n > 1 ? ` és utána ${f.rep === 'quarterly' ? 'negyedévente' : 'havonta'}, összesen ${n} tétel` : ''}
            </span>
          </>
        )}
        {mode === 'simple' && (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3,1fr)', gap: 6 }}>
            {['1', '2', '3', '4', '5', '6', '7', '8', '9', '000', '0', '⌫'].map((k) => (
              <button
                key={k}
                onClick={() => press(k)}
                style={{
                  height: 48,
                  border: 0,
                  borderRadius: 12,
                  background: k === '⌫' || k === '000' ? '#EEF2F7' : C.bg,
                  font: `600 20px ${FONT}`,
                  color: C.navy,
                }}
              >
                {k}
              </button>
            ))}
          </div>
        )}
        <button
          onClick={() => {
            if (mode !== 'simple') return saveComposite();
            if (!amt || !f.leaf) return;
            const name = f.name.trim() || ix.leafById[f.leaf].label;
            const b = genSeries({
              leaf: f.leaf,
              section: f.type,
              name,
              amount: amt,
              startYm: ymOf(f.date),
              count: f.rep === 'once' ? 1 : f.count,
              rep: f.rep,
              day: Number(f.date.slice(8)),
              payRule: f.rep === 'once' ? null : ruleOf(ix, f.leaf),
              tentative: offer,
            });
            commit(b, `${b.upsert!.length} tétel → ${ix.leafById[f.leaf].label}`);
            onSaved(ymOf(f.date));
            close();
          }}
          style={{ height: 52, border: 0, borderRadius: 999, background: C.blue, color: '#fff', font: `600 16px ${FONT}`, opacity: ready ? 1 : 0.6 }}
        >
          {!f.leaf ? 'Válassz ügyfelet / kategóriát' : !ready ? 'Adj meg összeget' : `Mentés · ${count} tétel${offer ? ' (ajánlat)' : ''}`}
        </button>
      </>
    );
  }

  if (sheet.kind === 'item') {
    const e = data.entries.find((x) => x.id === sheet.id);
    if (e) {
      const sign = sheet.section === 'in' ? 1 : -1;
      const later = data.entries.filter((x) => e.series_id && x.series_id === e.series_id && x.date >= e.date && !x.done).map((x) => x.id);
      const ids = sheet.all && later.length ? later : [e.id];
      const set = (p: Partial<typeof sheet>) => setSheet({ ...sheet, ...p });
      const series = data.series.find((s) => s.id === e.series_id);
      // a gyorsgombok az eredeti dátumhoz (lejártnál a mai naphoz) képest számolnak
      const base = e.date > data.today ? e.date : data.today;
      const quick: [string, string][] = [
        ['Jövő hétfő', mondayAfter(base, 1)],
        ['+2 hét', mondayAfter(base, 2)],
        ['+1 hónap', mondayOnOrAfter(addMonthsDate(base, 1))],
      ];
      const leafLabel = ix.leafById[sheet.leaf]?.label || '';
      const groupLabel = displayGroup(ix.groupById[ix.leafById[sheet.leaf]?.group_id]?.label || '');
      const lbl: React.CSSProperties = { font: `600 11px ${FONT}`, letterSpacing: '.12em', textTransform: 'uppercase', color: C.muted };
      const save = () => {
        const v = parseInt(sheet.amount) || 0;
        const shift = dayDiff(e.date, sheet.date);
        commit(
          {
            upsert: data.entries
              .filter((x) => ids.includes(x.id))
              .map((x) => ({
                ...x,
                amount: v * sign,
                leaf_id: sheet.leaf,
                name: sheet.name.trim().slice(0, 200),
                date: x.id === e.id ? sheet.date : addDays(x.date, shift),
              })),
          },
          `${ids.length > 1 ? ids.length + ' tétel' : sheet.name || 'Tétel'} mentve · ${fmt(v)} Ft`,
        );
        close();
      };
      body = (
        <>
          <span style={{ font: `600 11px ${FONT}`, letterSpacing: '.14em', textTransform: 'uppercase', color: C.blue }}>
            {series ? REP[series.rep] : e.source === 'billingo' ? 'Billingo számla' : e.tentative ? 'Ajánlat' : 'Terv'}
          </span>
          <input
            value={sheet.name}
            onChange={(ev) => set({ name: ev.target.value })}
            placeholder={leafLabel || 'Megnevezés'}
            style={{
              flex: 'none',
              height: 48,
              border: `1.5px solid ${C.line2}`,
              borderRadius: 12,
              padding: '0 14px',
              font: `700 17px ${FONT_H}`,
              color: C.navy,
              outline: 0,
            }}
          />
          <div
            style={{
              flex: 'none',
              display: 'flex',
              alignItems: 'center',
              border: `1.5px solid ${C.blue}`,
              background: C.bg2,
              borderRadius: 14,
              padding: '0 16px',
            }}
          >
            <input
              value={sheet.amount ? fmt(parseInt(sheet.amount)) : ''}
              onChange={(ev) => set({ amount: ev.target.value.replace(/\D/g, '').slice(0, 11) })}
              inputMode="numeric"
              placeholder="0"
              style={{ flex: 1, minWidth: 0, height: 58, border: 0, outline: 0, background: 'transparent', font: `800 26px ${FONT_H}`, color: C.navy }}
            />
            <span style={{ font: `700 18px ${FONT_H}`, color: C.blueDark }}>Ft</span>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <span style={lbl}>Dátum</span>
            <DateField big value={sheet.date} onChange={(v) => set({ date: v })} />
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3,1fr)', gap: 6 }}>
              {quick.map(([label, d]) => (
                <button
                  key={label}
                  onClick={() => set({ date: d })}
                  style={{
                    height: 52,
                    border: sheet.date === d ? `1.5px solid ${C.blue}` : 0,
                    borderRadius: 12,
                    background: sheet.date === d ? '#fff' : C.bg2,
                    color: C.blueDark,
                    display: 'flex',
                    flexDirection: 'column',
                    alignItems: 'center',
                    justifyContent: 'center',
                    lineHeight: 1.15,
                  }}
                >
                  <span style={{ font: `600 14px ${FONT}` }}>{label}</span>
                  <span style={{ font: `500 11.5px ${FONT}`, color: C.muted }}>hétfő, {d.slice(5).replace('-', '.')}.</span>
                </button>
              ))}
            </div>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <span style={lbl}>Kategória</span>
            <button
              onClick={() => set({ pick: !sheet.pick })}
              style={{
                minHeight: 50,
                border: `1.5px solid ${sheet.pick ? C.blue : C.line2}`,
                borderRadius: 12,
                background: '#fff',
                padding: '8px 14px',
                display: 'flex',
                alignItems: 'center',
                gap: 10,
                textAlign: 'left',
              }}
            >
              <span style={{ flex: 1, display: 'flex', flexDirection: 'column' }}>
                <b style={{ font: `600 15px ${FONT}`, color: C.navy }}>{leafLabel}</b>
                <span style={{ font: `500 12px ${FONT}`, color: C.muted }}>
                  {sheet.section === 'in' ? 'Bevétel' : 'Kiadás'} · {groupLabel}
                </span>
              </span>
              <span style={{ font: `600 13px ${FONT}`, color: C.blueDark }}>{sheet.pick ? 'Bezár' : 'Áthelyezés ›'}</span>
            </button>
            {sheet.pick && (
              <>
                <div style={{ display: 'flex', background: C.bg, border: `1px solid ${C.line}`, borderRadius: 12, padding: 3, gap: 2 }}>
                  {(
                    [
                      ['in', 'Bevétel'],
                      ['out', 'Kiadás'],
                    ] as [Section, string][]
                  ).map(([v, l]) => (
                    <button
                      key={v}
                      onClick={() => set({ section: v })}
                      style={{
                        flex: 1,
                        height: 38,
                        border: 0,
                        borderRadius: 10,
                        background: sheet.section === v ? C.navy : 'transparent',
                        color: sheet.section === v ? '#fff' : C.navy,
                        font: `600 14px ${FONT}`,
                      }}
                    >
                      {l}
                    </button>
                  ))}
                </div>
                <LeafPicker
                  key={sheet.section}
                  big
                  section={sheet.section}
                  value={ix.sectionOf(sheet.leaf) === sheet.section ? sheet.leaf : null}
                  onChange={(id) => set({ leaf: id, pick: false })}
                />
              </>
            )}
          </div>
          {later.length > 1 && (
            <label style={{ display: 'flex', alignItems: 'center', gap: 10, font: `500 14px ${FONT}`, color: C.ink }}>
              <input type="checkbox" checked={sheet.all} onChange={() => set({ all: !sheet.all })} style={{ width: 20, height: 20, accentColor: C.blue }} />A
              sorozat összes későbbi tételére is ({later.length})
            </label>
          )}
          <button
            onClick={() => {
              commit(markDone(data, [e.id], !e.done), e.done ? 'Újra nyitott' : 'Kész ✓');
              close();
            }}
            style={{
              height: 50,
              border: `1.5px solid ${C.blue}`,
              borderRadius: 999,
              background: e.done ? '#fff' : C.blue,
              font: `600 15px ${FONT}`,
              color: e.done ? C.blueDark : '#fff',
              marginTop: 4,
            }}
          >
            {e.done ? 'Kész ✓ · visszaállítás nyitottra' : '✓ Késznek jelöl'}
          </button>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 2fr', gap: 8 }}>
            <button
              onClick={() => {
                commit(deleteEntries(data, ids), `${ids.length} tétel törölve`);
                close();
              }}
              style={{ height: 50, border: `1.5px solid ${C.line}`, borderRadius: 999, background: '#fff', font: `600 14px ${FONT}`, color: C.neg }}
            >
              Törlés
            </button>
            <button
              onClick={save}
              disabled={ix.sectionOf(sheet.leaf) !== sheet.section}
              style={{
                height: 50,
                border: 0,
                borderRadius: 999,
                background: C.navy,
                font: `600 15px ${FONT}`,
                color: '#fff',
                opacity: ix.sectionOf(sheet.leaf) !== sheet.section ? 0.5 : 1,
              }}
            >
              {ix.sectionOf(sheet.leaf) !== sheet.section ? 'Válassz kategóriát' : 'Mentés'}
            </button>
          </div>
        </>
      );
    }
  }

  if (sheet.kind === 'detail') {
    const plan = sheet.planId ? data.entries.find((x) => x.id === sheet.planId) : undefined;
    const actual = sheet.actualId ? data.entries.find((x) => x.id === sheet.actualId) : undefined;
    const base = actual || plan;
    if (base) {
      const sign = ix.sectionOf(base.leaf_id) === 'in' ? 1 : -1;
      const diff = plan && actual ? (actual.amount - plan.amount) * sign : 0;
      const dev = plan && actual ? isDeviation(actual.amount, plan.amount) : false;
      const days = plan && actual ? daysBetween(plan.date, actual.date) : null;
      const openDays = plan && !plan.done && !actual ? daysBetween(plan.date, data.today) : null;
      const avg = avgDelay(data.entries, base.leaf_id);
      const doc = billingoDocFor(data.billingo, data.bankTx, plan, actual, ix.leafById[base.leaf_id]?.label);
      const tx = actual?.ext_ref?.startsWith('bank:') ? data.bankTx.find((t) => t.id === actual.ext_ref!.slice(5)) : undefined;
      const dd = (d: string) => d.replace(/-/g, '.') + '.';
      const lbl: React.CSSProperties = { font: `600 11px ${FONT}`, letterSpacing: '.12em', textTransform: 'uppercase', color: C.muted };
      const cell = (label: string, value: React.ReactNode, color?: string) => (
        <div style={{ background: C.bg, borderRadius: 12, padding: '10px 12px', display: 'flex', flexDirection: 'column', gap: 2 }}>
          <span style={lbl}>{label}</span>
          <b style={{ font: `700 16px ${FONT_H}`, color: color || C.navy, fontVariantNumeric: 'tabular-nums' }}>{value}</b>
        </div>
      );
      const openDoc = async () => {
        if (!doc) return;
        const w = window.open('', '_blank');
        try {
          const r = await api<{ url: string }>(`/api/billingo/doc/${doc.id}/url`);
          if (w) w.location.href = r.url;
          else window.location.href = r.url;
        } catch (e: any) {
          w?.close();
          alert(e.message || 'Nem sikerült megnyitni a számlát.');
        }
      };
      body = (
        <>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
            <span style={{ font: `600 11px ${FONT}`, letterSpacing: '.14em', textTransform: 'uppercase', color: C.blue }}>
              {plan && actual
                ? 'Teljesült terv'
                : actual
                  ? 'Tény (terv nélkül)'
                  : plan?.done
                    ? 'Késznek jelölt terv'
                    : plan?.tentative
                      ? 'Ajánlat (nyitott)'
                      : plan?.source === 'billingo'
                        ? 'Billingo számla (nyitott)'
                        : 'Nyitott terv'}
            </span>
            <span style={{ font: `700 19px ${FONT_H}`, color: C.navy }}>{plan?.name || actual?.name || ix.leafById[base.leaf_id]?.label}</span>
            <span style={{ font: `500 13px ${FONT}`, color: C.muted }}>
              {ix.sectionOf(base.leaf_id) === 'in' ? 'Bevétel' : 'Kiadás'} · {displayGroup(ix.groupById[ix.leafById[base.leaf_id]?.group_id]?.label || '')} ·{' '}
              {ix.leafById[base.leaf_id]?.label}
            </span>
            <button
              onClick={() => onPartner(base.leaf_id)}
              style={{ alignSelf: 'flex-start', border: 0, background: 'transparent', padding: '4px 0 0', color: C.blueDark, font: `600 13.5px ${FONT}` }}
            >
              {ix.leafById[base.leaf_id]?.label} – partner statisztika ›
            </button>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
            {cell('Terv', plan ? `${fmt(plan.amount * sign)} Ft` : '–')}
            {cell('Tény', actual ? `${fmt(actual.amount * sign)} Ft` : '–', dev ? C.neg : C.blueDark)}
            {cell('Tervezett dátum', plan ? dd(plan.date) : '–')}
            {cell('Teljesült', actual ? dd(actual.date) : plan?.done ? 'késznek jelölve' : 'még nyitott', !actual && plan && !plan.done ? C.muted : undefined)}
            {cell('Különbség', plan && actual ? `${diff > 0 ? '+' : diff < 0 ? '−' : ''}${fmt(Math.abs(diff))} Ft` : '–', dev ? C.neg : undefined)}
            {cell(
              'Eltérés napokban',
              days !== null
                ? days === 0
                  ? 'pontosan'
                  : `${Math.abs(days)} nap ${days > 0 ? 'késés' : 'korábban'}`
                : openDays === null
                  ? '–'
                  : openDays > 0
                    ? `${openDays} napja lejárt`
                    : openDays === 0
                      ? 'ma esedékes'
                      : `${-openDays} nap múlva`,
              (days !== null && days > 0) || (openDays !== null && openDays > 0) ? C.neg : undefined,
            )}
          </div>
          {avg && (
            <span style={{ font: `500 13px ${FONT}`, color: C.muted }}>
              Ebben a kategóriában átlagosan {Math.abs(Math.round(avg.avg))} nap {avg.avg >= 0 ? 'késés' : 'előny'} ({avg.n} teljesült tétel alapján).
            </span>
          )}
          {(tx || actual?.note) && (
            <div style={{ border: `1px solid ${C.line}`, borderRadius: 12, padding: '10px 12px', display: 'flex', flexDirection: 'column', gap: 2 }}>
              <span style={lbl}>Banki tétel</span>
              <span style={{ font: `600 14px ${FONT}`, color: C.ink }}>{tx?.partner || actual?.name}</span>
              <span style={{ font: `400 13px ${FONT}`, color: C.muted, wordBreak: 'break-word' }}>{tx?.memo || actual?.note}</span>
            </div>
          )}
          {doc ? (
            <button onClick={openDoc} style={{ height: 50, border: 0, borderRadius: 999, background: C.blue, color: '#fff', font: `600 15px ${FONT}` }}>
              🧾 Billingo számla megnyitása · {doc.number}
            </button>
          ) : (
            <span style={{ font: `500 12.5px ${FONT}`, color: C.faint, textAlign: 'center' }}>Ehhez a tételhez nem találtam Billingo számlát.</span>
          )}
          {plan && (
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
              <button
                onClick={() => {
                  commit(markDone(data, [plan.id], !plan.done), plan.done ? 'Terv újra nyitott' : 'Kész ✓');
                  close();
                }}
                style={{
                  height: 46,
                  border: `1.5px solid ${plan.done ? C.line2 : C.blue}`,
                  borderRadius: 999,
                  background: plan.done ? '#fff' : C.blue,
                  font: `600 14px ${FONT}`,
                  color: plan.done ? C.navy : '#fff',
                }}
              >
                {plan.done ? 'Visszaállítás nyitottra' : '✓ Késznek jelöl'}
              </button>
              <button
                onClick={() =>
                  setSheet({
                    back: sheet,
                    kind: 'item',
                    id: plan.id,
                    amount: String(Math.abs(plan.amount)),
                    date: plan.date,
                    name: plan.name,
                    leaf: plan.leaf_id,
                    section: ix.sectionOf(plan.leaf_id),
                    pick: false,
                    all: false,
                  })
                }
                style={{ height: 46, border: 0, borderRadius: 999, background: C.navy, font: `600 14px ${FONT}`, color: '#fff' }}
              >
                {plan.done ? 'Terv szerkesztése' : 'Szerkesztés'}
              </button>
            </div>
          )}
        </>
      );
    }
  }

  return (
    <div onClick={close} style={{ position: 'fixed', inset: 0, zIndex: 20, background: 'rgba(0,32,64,.45)', display: 'flex', alignItems: 'flex-end' }}>
      <div
        className="sheet"
        onClick={(e) => e.stopPropagation()}
        style={{
          width: '100%',
          background: '#fff',
          borderRadius: '24px 24px 0 0',
          padding: '10px 16px calc(env(safe-area-inset-bottom) + 20px)',
          display: 'flex',
          flexDirection: 'column',
          gap: 14,
          maxHeight: '92dvh',
          overflow: 'auto',
        }}
      >
        <i style={{ alignSelf: 'center', width: 40, height: 5, borderRadius: 999, background: C.line2, marginBottom: -8 }} />
        <div style={{ display: 'flex', alignItems: 'center', minHeight: 30 }}>
          <span style={{ flex: 1 }}>
            {sheet.kind === 'item' && sheet.back ? (
              <button
                onClick={() => setSheet(sheet.back!)}
                style={{ border: 0, background: 'transparent', padding: 0, color: C.blueDark, font: `600 14.5px ${FONT}` }}
              >
                ‹ Vissza az adatlapra
              </button>
            ) : null}
          </span>
          <span style={{ flex: 'none', display: 'flex', justifyContent: 'flex-end' }}>
            <button
              onClick={close}
              aria-label="Bezárás"
              style={{ width: 32, height: 32, borderRadius: 999, border: 0, background: C.bg, color: C.muted, font: `600 15px ${FONT}` }}
            >
              ✕
            </button>
          </span>
        </div>
        {body}
      </div>
    </div>
  );
}
