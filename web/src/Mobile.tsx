// Mobil nézet (iPhone): egy hónap, egy kéz – áttekintés, kategória, tervezett bevétel, bank, beállítások.
import { useMemo, useState } from 'react';
import { displayGroup } from '../../shared/categories';
import { actualBalanceAt, buildEstimates, fmt, fmtK, monthLabel, monthLong, monthRange, projection, ymOf, MSL } from '../../shared/model';
import type { Entry, Rep, Section } from '../../shared/types';
import { AlertsView, FlagBanner, useFlags } from './AlertsView';
import { useBack } from './back';
import { StatsView, type StatsTab } from './StatsView';
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
  | { kind: 'new'; type: Section; amount: string; name: string; leaf: string | null; rep: Rep; count: number; date: string }
  | { kind: 'detail'; planId: string | null; actualId: string | null }
  | { kind: 'item'; id: string; amount: string; date: string; name: string; leaf: string; section: Section; pick: boolean; all: boolean; back?: Sheet }
  | { kind: 'filters' };

export function Mobile({ onLogout }: { onLogout: () => void }) {
  const st = useStore();
  const { ix, data, filters, commit, toast, canEdit, run } = st;
  const [tab, setTab] = useState<Tab>('home');
  const flags = useFlags();
  const [partnerKey, setPartnerKey] = useState<string | null>(null);
  const [statsTab, setStatsTab] = useState<StatsTab>('pva');
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
    months.forEach((ym) => {
      let n = 0;
      if (ym < ix.cur) for (const [, mm] of ix.actual) n += mm.get(ym) || 0;
      else {
        for (const [, mm] of ym === ix.cur ? ix.actual : new Map()) n += mm.get(ym) || 0;
        for (const [, mm] of ix.openPlan) n += mm.get(ym) || 0;
        if (filters.includeOffers) for (const [, mm] of ix.offer) n += mm.get(ym) || 0;
        if (filters.estimate && ym > ix.cur) for (const [, mm] of est) n += mm.get(ym) || 0;
      }
      net.set(ym, n);
    });
    return { bal: new Map(months.map((ym) => [ym, ym < ix.cur ? actualBalanceAt(ix, ym) : (proj.get(ym) ?? ix.anchor)])), net };
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
  const maxV = Math.max(...months.map((ym) => Math.abs(balances.bal.get(ym) || 0)), 1);
  const G = ix.groupById[catId];
  const gIds = new Set(ix.leaves.filter((l) => l.group_id === catId).map((l) => l.id));
  const [rowFilter, setRowFilter] = useRowFilter();
  const allRows = useMemo(() => monthRows(data.entries, m, gIds, data.today), [data.entries, m, catId, data.today]);
  const rows = allRows.filter((r) => rowVisible(r, rowFilter));
  const rowCounts = {
    actual: allRows.filter((r) => r.completed).length,
    plan: allRows.filter((r) => !r.completed && r.kind === 'plan').length,
    offer: allRows.filter((r) => r.kind === 'offer').length,
  };
  const openItem = (e: Entry) =>
    setSheet({
      kind: 'item',
      id: e.id,
      amount: String(Math.abs(e.amount)),
      date: e.date,
      name: e.name,
      leaf: e.leaf_id,
      section: ix.sectionOf(e.leaf_id),
      pick: false,
      all: false,
    });
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
                  Havi cashflow:{' '}
                  <b style={{ color: (balances.net.get(m) || 0) < 0 ? C.negLight : C.blue2 }}>
                    {(balances.net.get(m) || 0) > 0 ? '+' : ''}
                    {fmt(balances.net.get(m) || 0)} Ft
                  </b>
                </span>
              </div>
              <div style={{ display: 'flex', gap: 6, alignItems: 'flex-end', height: 80, overflowX: 'auto', scrollbarWidth: 'none' }}>
                {months.map((ym) => {
                  const v = balances.bal.get(ym) || 0;
                  return (
                    <button
                      key={ym}
                      onClick={() => setM(ym)}
                      style={{
                        flex: `1 0 ${months.length > 10 ? 30 : 0}px`,
                        height: '100%',
                        border: 0,
                        background: 'transparent',
                        padding: 0,
                        display: 'flex',
                        flexDirection: 'column',
                        justifyContent: 'flex-end',
                        alignItems: 'center',
                        gap: 5,
                      }}
                    >
                      <div
                        style={{
                          width: '100%',
                          height: `${Math.max(6, Math.round((Math.abs(v) / maxV) * 72))}%`,
                          borderRadius: '6px 6px 2px 2px',
                          background: v < 0 ? C.neg : ym === m ? C.blue2 : ym < ix.cur ? '#2C5578' : C.navy3,
                        }}
                      />
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
            <div style={{ margin: '14px 16px 0', display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
              {(
                [
                  ['pva', 'Terv vs. tény', 'havonta: bevétel, kiadás, profit'],
                  ['partners', 'Partnerek', 'statisztika, fizetési előzmények'],
                ] as [StatsTab, string, string][]
              ).map(([t, title, sub]) => (
                <button
                  key={t}
                  onClick={() => (setPartnerKey(null), setStatsTab(t), setTab('stats'))}
                  style={{
                    border: `1px solid ${C.line2}`,
                    background: '#fff',
                    borderRadius: 14,
                    padding: '12px 14px',
                    display: 'flex',
                    flexDirection: 'column',
                    gap: 3,
                    textAlign: 'left',
                  }}
                >
                  <b style={{ font: `700 14px ${FONT}`, color: C.navy }}>{title} ›</b>
                  <span style={{ font: `500 12px ${FONT}`, color: C.muted }}>{sub}</span>
                </button>
              ))}
            </div>
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
                onOpenPlan={openItem}
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
            <MobileHeader title="Statisztika" sub="Terv vs. tény · partnerek" onBack={() => (setPartnerKey(null), setTab('home'))} />
            <StatsView key={(partnerKey || '') + statsTab} mobile initialTab={statsTab} partnerKey={partnerKey} onPartnerBack={() => setPartnerKey(null)} />
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
            <IncomeView mobile />
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
        <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'center', gap: 8, paddingTop: 2 }}>
          <span style={{ font: `800 40px ${FONT_H}`, color: amt ? C.navy : C.faint, letterSpacing: '-.02em', fontVariantNumeric: 'tabular-nums' }}>
            {amt ? fmt(amt) : '0'}
          </span>
          <span style={{ font: `600 16px ${FONT}`, color: C.muted }}>Ft</span>
        </div>
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
        <button
          onClick={() => {
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
            });
            commit(b, `${b.upsert!.length} tétel → ${ix.leafById[f.leaf].label}`);
            onSaved(ymOf(f.date));
            close();
          }}
          style={{ height: 52, border: 0, borderRadius: 999, background: C.blue, color: '#fff', font: `600 16px ${FONT}`, opacity: amt && f.leaf ? 1 : 0.6 }}
        >
          {!f.leaf ? 'Válassz kategóriát' : !amt ? 'Adj meg összeget' : `Mentés · ${n} tétel`}
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
              {plan && actual ? 'Teljesült terv' : actual ? 'Tény (terv nélkül)' : 'Késznek jelölt terv'}
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
            {cell('Teljesült', actual ? dd(actual.date) : plan?.done ? 'késznek jelölve' : '–')}
            {cell('Különbség', plan && actual ? `${diff > 0 ? '+' : diff < 0 ? '−' : ''}${fmt(Math.abs(diff))} Ft` : '–', dev ? C.neg : undefined)}
            {cell(
              'Eltérés napokban',
              days === null ? '–' : days === 0 ? 'pontosan' : `${Math.abs(days)} nap ${days > 0 ? 'késés' : 'korábban'}`,
              days !== null && days > 0 ? C.neg : undefined,
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
                  commit(markDone(data, [plan.id], false), 'Terv újra nyitott');
                  close();
                }}
                style={{ height: 46, border: `1.5px solid ${C.line2}`, borderRadius: 999, background: '#fff', font: `600 14px ${FONT}`, color: C.navy }}
              >
                Visszaállítás nyitottra
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
                Terv szerkesztése
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
