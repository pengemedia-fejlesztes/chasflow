// Asztali nézet: oldalsáv + Áttekintés / Kategória / Tervezett bevétel / Bank / Beállítások.
import { Fragment, useEffect, useMemo, useState } from 'react';
import { displayGroup } from '../../shared/categories';
import { addMonths, buildMatrix, fmt, fmtM, monthLabel, monthLong, outlook, ymOf, type Matrix } from '../../shared/model';
import { AlertsView, FlagBanner, useFlags } from './AlertsView';
import { api, ApiError } from './api';
import { BankView } from './BankView';
import { BreakevenView } from './BreakevenView';
import { CategoryView } from './CategoryView';
import type { EditTarget } from './EntryModal';
import { diffColor, diffText, planLinks } from './LinkChain';
import { PartnerModal } from './PartnerModal';
import { PartnerRegistry } from './PartnerCard';
import { FilterBar, periodLabel } from './Filters';
import { IncomeView } from './IncomeView';
import { planActual, setCellValue } from './logic';
import { SettingsView } from './SettingsView';
import { useStore } from './store';
import { APP_VERSION, VERSION_LABEL } from './version';
import { C, FONT, FONT_H, Pill, ToastView, card, eyebrow, relTime } from './ui';

export type View = 'overview' | 'alerts' | 'cat' | 'income' | 'bank' | 'partners' | 'breakeven' | 'settings';

export function Desktop({ onLogout }: { onLogout: () => void }) {
  const st = useStore();
  const { ix, data, filters, setFilters, toast, canEdit } = st;
  const [view, setView] = useState<View>(() => (new URLSearchParams(location.search).get('tab') === 'alerts' ? 'alerts' : 'overview'));
  const [modal, setModal] = useState<{ leaf?: string | null; edit?: EditTarget | null } | null>(null);
  // az Áttekintés nem a kiválasztott kategóriára szűr (az csak a kategória nézeté) – különben pl. csak az Ajánlatok látszanának
  const matrix = useMemo(() => buildMatrix(ix, view === 'cat' ? filters : { ...filters, groupId: null }), [ix, filters, view]);

  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      const t = (e.target as HTMLElement).tagName;
      if (e.key === 'Escape' && modal) setModal(null);
      else if ((e.key === 'n' || e.key === 'N') && !modal && canEdit && !['INPUT', 'SELECT', 'TEXTAREA'].includes(t) && !e.metaKey && !e.ctrlKey) {
        e.preventDefault();
        setModal({});
      }
    };
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [modal, canEdit]);

  const flags = useFlags();
  const newTx = data.bankTx.filter((t) => t.status === 'new').length;
  const openIncome = data.entries.filter((e) => e.kind === 'plan' && !e.done && ix.sectionOf(e.leaf_id) === 'in' && !e.tentative).length;
  // az oldalsáv mindig mutatja a bevételi és a kiadási kategóriákat is (a Bevétel/Kiadás szűrőtől függetlenül)
  const sideMatrix = useMemo(() => buildMatrix(ix, { ...filters, section: 'all', groupId: null, search: '' }), [ix, filters]);
  const groupRows = sideMatrix.rows.filter((r) => r.type === 'group');
  const goGroup = (id: string) => {
    setFilters({ groupId: id });
    setView('cat');
  };
  const nav: [View, string, number][] = [
    ['overview', 'Áttekintés', 0],
    ['alerts', 'Riasztások', flags.length],
    ['income', 'Tervezett bevétel', openIncome],
    ['bank', 'Bankszinkron', newTx],
    ['partners', 'Partnertörzs', 0],
    ['breakeven', 'Fedezeti pont', 0],
    ['settings', 'Beállítások', 0],
  ];

  return (
    <div style={{ display: 'grid', gridTemplateColumns: '256px minmax(0,1fr)', height: '100vh', overflow: 'hidden' }}>
      <aside style={{ background: C.navy, color: '#fff', display: 'flex', flexDirection: 'column', overflow: 'auto' }}>
        <div style={{ padding: '22px 22px 18px', display: 'flex', alignItems: 'center', gap: 11 }}>
          <div style={{ width: 34, height: 34, borderRadius: 999, background: C.blue, display: 'grid', placeItems: 'center', font: `800 11px ${FONT_H}` }}>
            CF
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', lineHeight: 1.15 }}>
            <span style={{ font: `700 16px ${FONT_H}`, letterSpacing: '-.01em' }}>
              Cashflow <b style={{ color: C.blue2 }}>tervező</b>
            </span>
            <span style={{ font: `600 10px ${FONT}`, letterSpacing: '.14em', textTransform: 'uppercase', color: C.muted2 }}>
              360 Marketing ·{' '}
              <span title={VERSION_LABEL} style={{ textTransform: 'none', letterSpacing: '.04em', color: C.blue2 }}>
                {APP_VERSION}
              </span>
            </span>
          </div>
        </div>
        {canEdit && (
          <div style={{ padding: '0 14px 14px' }}>
            <button
              className="hov-primary"
              onClick={() => setModal({})}
              style={{
                width: '100%',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                background: C.blue,
                color: '#fff',
                border: 0,
                borderRadius: 999,
                padding: '11px 16px 11px 18px',
                font: `600 14px ${FONT}`,
                cursor: 'pointer',
              }}
            >
              <span>+ Új tétel</span>
              <span style={{ font: `600 11px ${FONT}`, background: 'rgba(255,255,255,.18)', borderRadius: 6, padding: '2px 7px' }}>N</span>
            </button>
          </div>
        )}
        <nav style={{ display: 'flex', flexDirection: 'column', gap: 2, padding: '0 10px' }}>
          {nav.map(([v, label, badge]) => (
            <button
              key={v}
              className="side-btn"
              onClick={() => setView(v)}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 10,
                border: 0,
                cursor: 'pointer',
                textAlign: 'left',
                padding: '10px 12px',
                borderRadius: 8,
                background: view === v ? C.navy3 : 'transparent',
                color: '#fff',
                font: `600 14px ${FONT}`,
              }}
            >
              <span style={{ flex: 1 }}>{label}</span>
              {badge > 0 && (
                <span
                  style={{
                    minWidth: 22,
                    textAlign: 'center',
                    background: v === 'alerts' ? C.negLight : C.blue2,
                    color: C.navy,
                    borderRadius: 999,
                    padding: '1px 7px',
                    font: `700 11.5px ${FONT}`,
                  }}
                >
                  {badge}
                </span>
              )}
            </button>
          ))}
        </nav>
        <div
          style={{
            padding: '22px 22px 8px',
            font: `600 11px ${FONT}`,
            letterSpacing: '.16em',
            textTransform: 'uppercase',
            color: C.muted2,
            display: 'flex',
            justifyContent: 'space-between',
            gap: 8,
          }}
        >
          <span>Kategóriák</span>
          <span style={{ letterSpacing: '.04em', textTransform: 'none', textAlign: 'right' }}>{periodLabel(filters, ix.cur, ix.firstActual)}</span>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', padding: '0 10px 20px', gap: 1 }}>
          {(['in', 'out'] as const).map((sec) => {
            const gs = groupRows.filter((g) => g.section === sec);
            if (!gs.length) return null;
            return (
              <Fragment key={sec}>
                <div style={{ padding: '12px 12px 6px', font: `700 12px ${FONT_H}`, color: sec === 'in' ? C.blue2 : C.muted2, letterSpacing: '.02em' }}>
                  {sec === 'in' ? 'Bevétel' : 'Kiadás'}
                </div>
                {gs.map((g) => (
                  <button
                    key={g.id}
                    className="side-btn"
                    onClick={() => goGroup(g.id)}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 8,
                      border: 0,
                      cursor: 'pointer',
                      textAlign: 'left',
                      padding: '8px 12px',
                      borderRadius: 8,
                      background: view === 'cat' && filters.groupId === g.id ? C.navy3 : 'transparent',
                      color: '#fff',
                      font: `500 13.5px ${FONT}`,
                    }}
                  >
                    <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{displayGroup(g.label)}</span>
                    <span style={{ font: `500 12px ${FONT}`, color: C.muted2, fontVariantNumeric: 'tabular-nums' }}>{fmtM(g.total)}</span>
                  </button>
                ))}
              </Fragment>
            );
          })}
        </div>
        <div
          style={{ marginTop: 'auto', padding: '16px 22px', borderTop: '1px solid rgba(255,255,255,.08)', display: 'flex', flexDirection: 'column', gap: 6 }}
        >
          <span style={{ font: `600 10.5px ${FONT}`, letterSpacing: '.14em', textTransform: 'uppercase', color: C.muted2 }}>Kapcsolatok</span>
          {data.accounts
            .filter((a) => a.active)
            .map((a) => (
              <span key={a.id} style={{ display: 'flex', alignItems: 'center', gap: 8, font: `500 13px ${FONT}` }}>
                <i
                  style={{
                    width: 7,
                    height: 7,
                    borderRadius: '50%',
                    background: a.last_error ? C.negLight : C.blue2,
                    boxShadow: '0 0 0 3px rgba(61,155,208,.25)',
                  }}
                />
                {a.bank_name} · {relTime(a.last_sync)}
              </span>
            ))}
          <span style={{ display: 'flex', alignItems: 'center', gap: 8, font: `500 13px ${FONT}` }}>
            <i style={{ width: 7, height: 7, borderRadius: '50%', background: data.integrations.billingo ? C.blue2 : C.muted }} />
            Billingo · {data.integrations.billingo ? relTime(data.settings.billingo_last_sync) : 'nincs beállítva'}
          </span>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 10 }}>
            <span style={{ font: `500 12.5px ${FONT}`, color: C.muted2 }}>{data.me.name}</span>
            <button onClick={onLogout} style={{ border: 0, background: 'transparent', color: C.blue2, font: `600 12.5px ${FONT}`, cursor: 'pointer' }}>
              Kilépés
            </button>
          </div>
        </div>
      </aside>

      <main style={{ overflow: 'auto', position: 'relative' }}>
        {view === 'overview' && (
          <Overview
            matrix={matrix}
            netAll={sideMatrix.net}
            goBank={() => setView('bank')}
            goAlerts={() => setView('alerts')}
            goGroup={goGroup}
            openNew={(leaf) => setModal({ leaf })}
          />
        )}
        {view === 'alerts' && <AlertsView />}
        {view === 'cat' && filters.groupId && <CategoryView groupId={filters.groupId} openModal={(leaf, edit) => setModal({ leaf, edit })} />}
        {view === 'cat' && !filters.groupId && <div style={{ padding: 32 }}>Válassz kategóriát a bal oldalon.</div>}
        {view === 'income' && <IncomeView />}
        {view === 'bank' && <BankView />}
        {view === 'partners' && (
          <div style={{ padding: '28px 32px 120px', display: 'flex', flexDirection: 'column', gap: 18, maxWidth: 1100 }}>
            <h1 style={{ margin: 0, font: `700 30px/1.05 ${FONT_H}`, color: C.navy }}>Partnertörzs</h1>
            <PartnerRegistry />
          </div>
        )}
        {view === 'breakeven' && <BreakevenView />}
        {view === 'settings' && <SettingsView onLogout={onLogout} />}
      </main>
      {modal && <PartnerModal leaf={modal.leaf} edit={modal.edit} onClose={() => setModal(null)} />}
      {toast && <ToastView {...toast} />}
    </div>
  );
}

/**
 * Bevételi tölcsér: Projektek (biztos terv), Ajánlatok, a kettő együtt, és a projektek tervhez kötött ténye
 * (a terv hónapjában: amihez számlamozgás tartozik) – hogy a terv mennyire valósult meg.
 */
/**
 * Terv vs. tény eltérés: az előző és az aktuális hónap lezárt tervei (a tény hónapja szerint), partnerenként.
 * A terv összege nem változik a számla / tény miatt, így ez a valódi eltérés. Bevételnél + = több jött, kiadásnál + = többet fizettünk.
 */
function DeviationCard() {
  const { data, ix, openPartner } = useStore();
  const months = [addMonths(ix.cur, -1), ix.cur];
  const [ym, setYm] = useState(ix.cur);
  const rows = useMemo(() => {
    const links = planLinks(data.entries, () => true).filter((l) => l.actual && ymOf(l.actual.date) === ym && l.diff);
    const by = new Map<string, { leaf: string; diff: number; plan: number; act: number; n: number }>();
    for (const l of links) {
      const r = by.get(l.plan.leaf_id) || { leaf: l.plan.leaf_id, diff: 0, plan: 0, act: 0, n: 0 };
      r.diff += l.diff!;
      r.plan += Math.abs(l.plan.amount);
      r.act += Math.abs(l.actual!.amount);
      r.n++;
      by.set(l.plan.leaf_id, r);
    }
    return [...by.values()].sort((a, b) => Math.abs(b.diff) - Math.abs(a.diff));
  }, [data.entries, ym]);
  const tot = (sec: 'in' | 'out') => rows.filter((r) => ix.sectionOf(r.leaf) === sec).reduce((a, r) => a + r.diff, 0);
  return (
    <div style={{ ...card, padding: '16px 20px', display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <b style={{ flex: 1, font: `700 16px ${FONT_H}`, color: C.navy }}>Terv vs. tény eltérés</b>
        {months.map((m) => (
          <Pill key={m} small kind={m === ym ? 'dark' : undefined} onClick={() => setYm(m)}>
            {monthLong(m)}
          </Pill>
        ))}
      </div>
      <div style={{ display: 'flex', gap: 22, flexWrap: 'wrap', font: `500 13px ${FONT}`, color: C.muted }}>
        <span>
          Bevétel: <b style={{ color: diffColor('in', tot('in')) }}>{diffText(tot('in'))} Ft</b>
        </span>
        <span>
          Kiadás: <b style={{ color: diffColor('out', tot('out')) }}>{diffText(tot('out'))} Ft</b>
        </span>
        <span>Lezárt, eltérő tételek: {rows.reduce((a, r) => a + r.n, 0)}</span>
      </div>
      {rows.length === 0 ? (
        <span style={{ font: `500 13px ${FONT}`, color: C.muted }}>Ebben a hónapban minden lezárt tétel pontosan a terv szerint teljesült (vagy még nincs lezárt tétel).</span>
      ) : (
        rows.slice(0, 10).map((r) => {
          const sec = ix.sectionOf(r.leaf);
          return (
            <button
              key={r.leaf}
              onClick={() => openPartner(r.leaf)}
              className="hov-light"
              style={{ display: 'flex', gap: 10, alignItems: 'baseline', border: 0, borderTop: `1px solid ${C.line3}`, background: 'transparent', padding: '7px 0', cursor: 'pointer', textAlign: 'left' }}
            >
              <span style={{ flex: 1, minWidth: 0, font: `600 13.5px ${FONT}`, color: C.navy }}>
                {ix.leafById[r.leaf]?.label}{' '}
                <span style={{ font: `500 11.5px ${FONT}`, color: C.muted }}>
                  · {sec === 'in' ? 'bevétel' : 'kiadás'} · terv {fmt(r.plan)} → tény {fmt(r.act)}
                </span>
              </span>
              <b style={{ font: `700 13.5px ${FONT}`, color: diffColor(sec, r.diff), fontVariantNumeric: 'tabular-nums' }}>{diffText(r.diff)} Ft</b>
            </button>
          );
        })
      )}
    </div>
  );
}

function PipelineCard({ cols, matrix, netAll, goGroup }: { cols: Matrix['columns']; matrix: Matrix; netAll: number[]; goGroup: (id: string) => void }) {
  const { ix, data } = useStore();
  const inGroups = ix.groups.filter((g) => g.section === 'in');
  const offerG = inGroups.filter((g) => /aj[áa]nlat/i.test(g.label));
  const projG = inGroups.filter((g) => /projekt/i.test(g.label));
  const groupOf = (l: string) => ix.leafById[l]?.group_id;
  const isOfferG = (l: string) => offerG.some((g) => g.id === groupOf(l));
  const inProj = (l: string) => (projG.length ? projG.some((g) => g.id === groupOf(l)) : ix.sectionOf(l) === 'in' && !isOfferG(l));
  const proj = useMemo(() => planActual(data.entries, inProj, 1), [data.entries, ix]); // eslint-disable-line react-hooks/exhaustive-deps
  const offerAll = useMemo(() => planActual(data.entries, (l) => ix.sectionOf(l) === 'in', 1), [data.entries, ix]);
  const offerGrp = useMemo(() => planActual(data.entries, isOfferG, 1), [data.entries, ix]); // eslint-disable-line react-hooks/exhaustive-deps
  // az aktuális hónap tény + terv oszlopa egy oszlop itt
  const cs = cols.filter((c, i) => !(c.current && c.kind === 'actual' && cols[i + 1]?.current));
  const sum = (m: Map<string, number>, c: Matrix['columns'][number]) => c.months.reduce((a, ym) => a + (m.get(ym) || 0), 0);
  // ajánlat = minden nyitott (nem biztos) bevételi terv + az Ajánlatok csoportban még ott álló tervek
  const offer = (c: Matrix['columns'][number]) => sum(offerAll.offer, c) + sum(offerGrp.plan, c);
  const past = (c: Matrix['columns'][number]) => c.months[0] <= ix.cur;
  /**
   * Profit = havi bevétel − kiadás (a fenti szűrők szerint: tény/terv, becslés, ajánlatok).
   * A folyó hónap itt egy oszlop: tény + terv, a már teljesült (tényhez kötött) terv nélkül.
   */
  const profit = (c: Matrix['columns'][number]) => {
    const i = matrix.columns.findIndex((x) => x.key === c.key);
    if (i < 0) return null;
    let v = netAll[i];
    const prev = matrix.columns[i - 1];
    if (c.current && c.kind !== 'actual' && prev?.current && prev.kind === 'actual') {
      v += netAll[i - 1];
      for (const [leaf, mm] of ix.plan) for (const ym of c.months) v -= (mm.get(ym) || 0) - (ix.openPlan.get(leaf)?.get(ym) || 0);
    }
    return v;
  };
  const rows: [string, (c: Matrix['columns'][number]) => number | null, string, (() => void) | undefined][] = [
    ['Projektek – terv (biztos)', (c) => sum(proj.plan, c), C.navy, projG[0] ? () => goGroup(projG[0].id) : undefined],
    ['Ajánlatok (nem biztos)', offer, '#8A6D1C', offerG[0] ? () => goGroup(offerG[0].id) : undefined],
    ['Projektek + ajánlatok', (c) => sum(proj.plan, c) + offer(c), C.navy, undefined],
    ['Projektek – tény (tervhez kötött)', (c) => (past(c) || sum(proj.linked, c) ? sum(proj.linked, c) : null), C.blue, undefined],
    ['Teljesülés', (c) => (past(c) ? sum(proj.linked, c) - sum(proj.plan, c) : null), '', undefined],
    ['Profit (bevétel − kiadás)', profit, '', undefined],
  ];
  const PROFIT_FROM = 5;
  const BOLD = new Set(['Projektek + ajánlatok', 'Profit (bevétel − kiadás)']);
  const SIGNED = new Set(['Teljesülés', 'Profit (bevétel − kiadás)']);
  if (!cs.length) return null;
  return (
    <div style={{ ...card, padding: 0, overflow: 'auto' }}>
      <div style={{ padding: '14px 18px 6px', display: 'flex', alignItems: 'baseline', gap: 10, flexWrap: 'wrap' }}>
        <span style={{ font: `700 15px ${FONT_H}`, color: C.navy }}>Bevétel és profit · Projektek és ajánlatok</span>
        <span style={{ font: `400 12.5px ${FONT}`, color: C.muted }}>terv = amivel terveztél · tény = a tervhez kötött számlamozgás (a terv hónapjában)</span>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: `minmax(230px,1.7fr) repeat(${cs.length},minmax(96px,1fr))`, minWidth: 250 + cs.length * 100 }}>
        <div />
        {cs.map((c) => (
          <div key={c.key} style={{ padding: '6px 8px', textAlign: 'right', font: `700 11.5px ${FONT}`, color: c.current ? C.blue : C.muted }}>
            {c.label}
          </div>
        ))}
        {rows.map(([label, f, col, go], ri) => (
          <Fragment key={label}>
            <div
              onClick={go}
              style={{
                padding: '9px 18px',
                font: `${BOLD.has(label) ? 700 : 600} 13px ${FONT}`,
                color: C.navy,
                borderTop: ri === PROFIT_FROM ? `2px solid ${C.line2}` : `1px solid ${ri === 3 ? C.line2 : C.line}`,
                cursor: go ? 'pointer' : 'default',
              }}
            >
              {label}
              {go ? ' ›' : ''}
            </div>
            {cs.map((c) => {
              const v = f(c);
              const color = col || (v === null || !Math.round(v) ? C.muted : v >= 0 ? '#2E7D4F' : C.neg);
              return (
                <div
                  key={c.key}
                  style={{
                    padding: '9px 8px',
                    textAlign: 'right',
                    borderTop: ri === PROFIT_FROM ? `2px solid ${C.line2}` : `1px solid ${ri === 3 ? C.line2 : C.line}`,
                    font: `${BOLD.has(label) ? 700 : 600} 12.5px ${FONT}`,
                    color,
                    fontVariantNumeric: 'tabular-nums',
                  }}
                >
                  {v === null ? '' : !Math.round(v) ? '–' : (SIGNED.has(label) && v > 0 ? '+' : '') + fmt(v)}
                </div>
              );
            })}
          </Fragment>
        ))}
      </div>
    </div>
  );
}

function Kpi(p: { label: string; value: string; sub: string; dark?: boolean; color?: string; onClick?: () => void }) {
  const style = p.dark
    ? { background: C.navy2, border: 0 }
    : p.onClick
      ? { background: C.bg2, border: `1px solid ${C.line2}`, cursor: 'pointer' }
      : { ...card };
  const Tag = p.onClick ? 'button' : 'div';
  return (
    <Tag
      onClick={p.onClick}
      style={{ ...style, textAlign: 'left', borderRadius: 14, padding: '18px 20px', display: 'flex', flexDirection: 'column', gap: 6, minWidth: 0 }}
    >
      <span style={{ ...eyebrow, color: p.dark ? C.muted2 : p.onClick ? C.blueDark : C.muted }}>{p.label}</span>
      <span
        style={{
          font: `800 24px/1 ${FONT_H}`,
          color: p.color || (p.dark ? '#fff' : C.navy),
          letterSpacing: '-.02em',
          fontVariantNumeric: 'tabular-nums',
          whiteSpace: 'nowrap',
        }}
      >
        {p.value}
      </span>
      <span style={{ font: `${p.onClick ? 600 : 400} 12.5px ${FONT}`, color: p.dark ? C.muted2 : p.onClick ? C.blueDark : C.muted }}>{p.sub}</span>
    </Tag>
  );
}

function Overview({
  matrix,
  netAll,
  goBank,
  goAlerts,
  goGroup,
  openNew,
}: {
  matrix: Matrix;
  /** havi bevétel − kiadás (a kategória/keresés szűrő nélkül; tény/terv, becslés, ajánlat szerint) */
  netAll: number[];
  goBank: () => void;
  goAlerts: () => void;
  goGroup: (id: string) => void;
  openNew: (leaf: string) => void;
}) {
  const st = useStore();
  const { ix, data, filters, canEdit, commit } = st;
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const [editing, setEditing] = useState<{ leaf: string; col: number } | null>(null);
  const [dense, setDense] = useState(true);
  const ol = useMemo(() => outlook(ix, filters), [ix, filters]);
  const flags = useFlags();
  const cols = matrix.columns;
  const rowH = dense ? 36 : 44;
  const curOl = ol.months[0];
  const newTx = data.bankTx.filter((t) => t.status === 'new').length;
  const anyCollapsed = Object.values(collapsed).some(Boolean);
  const NEG = C.neg;
  const grid = `minmax(240px,1.7fr) repeat(${cols.length},minmax(${filters.granularity === 'year' ? 120 : 104}px,1fr))`;
  const minW = 260 + cols.length * 108;

  // grafikon: egy oszlop / hónap (az aktuális hónapból a terv-oszlop egyenlege)
  const bars = useMemo(() => {
    const out: { label: string; v: number; kind: 'actual' | 'proj'; cur: boolean }[] = [];
    cols.forEach((c, i) => {
      if (c.current && c.kind === 'actual' && cols[i + 1]?.current) return;
      out.push({ label: filters.granularity === 'year' ? c.label : monthLabel(c.last), v: matrix.balance[i], kind: matrix.balanceKind[i], cur: c.current });
    });
    return out.slice(-24);
  }, [cols, matrix, filters.granularity]);
  const maxV = Math.max(...bars.map((b) => Math.abs(b.v)), 1);
  const minIdx = bars.reduce((mi, b, i) => (b.v < bars[mi].v ? i : mi), 0);
  const hasNeg = bars.some((b) => b.v < 0);

  const commitCell = (leaf: string, colIdx: number, raw: string) => {
    setEditing(null);
    const v = parseInt(String(raw).replace(/[^\d-]/g, ''));
    if (isNaN(v)) return;
    const c = cols[colIdx];
    const b = setCellValue(data, leaf, ix.sectionOf(leaf), c.last, v);
    if (b) commit(b, `${ix.leafById[leaf].label} · ${monthLabel(c.last)} → ${fmt(v)} Ft`);
  };

  const cellText = (v: number, est: number, offer: number) => {
    if (!Math.round(v)) return '–';
    return (est ? '≈ ' : '') + fmt(v) + (offer ? ' *' : '');
  };

  return (
    <div style={{ padding: '28px 32px 120px', display: 'flex', flexDirection: 'column', gap: 18 }}>
      <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', gap: 16, flexWrap: 'wrap' }}>
        <div>
          <div style={{ font: `600 12px ${FONT}`, letterSpacing: '.18em', textTransform: 'uppercase', color: C.blue, marginBottom: 8 }}>
            Áttekintés · {monthLong(ix.cur)}
          </div>
          <h1 style={{ margin: 0, font: `700 30px/1.05 ${FONT_H}`, color: C.navy, letterSpacing: '-.01em' }}>Cashflow</h1>
        </div>
        <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
          {canEdit && <span style={{ font: `400 12.5px ${FONT}`, color: C.muted }}>Terv cellára kattintva módosíthatsz · Enter = mentés</span>}
          <Pill onClick={() => setDense(!dense)}>{dense ? 'Kényelmes' : 'Kompakt'}</Pill>
          <Pill
            onClick={() => {
              if (anyCollapsed) setCollapsed({});
              else {
                const c: Record<string, boolean> = {};
                matrix.rows.filter((r) => r.type === 'group').forEach((r) => (c[r.id] = true));
                setCollapsed(c);
              }
            }}
          >
            {anyCollapsed ? 'Mind kibontása' : 'Csak kategóriák'}
          </Pill>
        </div>
      </div>

      {flags.length > 0 && <FlagBanner n={flags.length} kinds={flags.map((f) => f.kind)} onClick={goAlerts} />}

      <FilterBar />

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(190px,1fr))', gap: 14 }}>
        <Kpi
          dark
          label={ix.anchorSource === 'bank' ? 'Banki egyenleg' : 'Számított egyenleg'}
          value={fmt(ix.anchor) + ' Ft'}
          sub={
            ix.anchorSource === 'bank'
              ? `${data.accounts
                  .filter((a) => a.active && a.balance != null)
                  .map((a) => a.bank_name)
                  .join(' + ')} · ${relTime(Math.max(...data.accounts.map((a) => a.balance_at || 0)))}`
              : 'nyitó egyenleg + tények'
          }
        />
        <Kpi label={`${monthLabel(ix.cur)} várható záró`} value={fmt(curOl.bal) + ' Ft'} sub="nyitott tervezett tételekkel" />
        <Kpi
          label={`Havi cashflow · ${monthLabel(ix.cur)}`}
          value={(curOl.net > 0 ? '+' : '') + fmt(curOl.net)}
          color={curOl.net < 0 ? NEG : undefined}
          sub="tény + nyitott terv"
        />
        <Kpi
          label="Legalacsonyabb egyenleg"
          value={fmt(ol.next12.minBal) + ' Ft'}
          color={ol.next12.minBal < 0 ? NEG : undefined}
          sub={`${monthLong(ol.next12.minYm)} végén (12 hó)`}
        />
        <Kpi label="Bankszinkron" value={`${newTx} új tétel`} sub="Jóváhagyás →" onClick={goBank} />
      </div>

      <PipelineCard cols={cols} matrix={matrix} netAll={netAll} goGroup={goGroup} />

      <DeviationCard />

      <div style={{ ...card, padding: '18px 22px', display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(220px,1fr))', gap: 18 }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <span style={{ font: `700 15px ${FONT_H}`, color: C.navy }}>Jövő 12 hónap becslése</span>
          <span style={{ font: `400 12.5px ${FONT}`, color: C.muted }}>
            tervek{filters.estimate ? ' + tényekből becsült rendszeres tételek' : ''}
            {filters.includeOffers ? ' + ajánlatok' : ''}
          </span>
        </div>
        {[
          ['Bevétel', ol.next12.inc, ol.last12.inc],
          ['Kiadás', ol.next12.exp, ol.last12.exp],
          ['Nettó', ol.next12.net, ol.last12.net],
        ].map(([l, v, p]) => (
          <div key={l as string} style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
            <span style={eyebrow}>{l}</span>
            <span style={{ font: `800 20px ${FONT_H}`, color: (v as number) < 0 ? NEG : C.navy, fontVariantNumeric: 'tabular-nums' }}>
              {fmt(v as number)} Ft
            </span>
            <span style={{ font: `500 12px ${FONT}`, color: C.muted }}>elmúlt 12 hó tény: {fmt(p as number)} Ft</span>
          </div>
        ))}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
          <span style={eyebrow}>Egyenleg 12 hó múlva</span>
          <span style={{ font: `800 20px ${FONT_H}`, color: ol.next12.endBal < 0 ? NEG : C.navy, fontVariantNumeric: 'tabular-nums' }}>
            {fmt(ol.next12.endBal)} Ft
          </span>
          <span style={{ font: `500 12px ${FONT}`, color: C.muted }}>{monthLong(ol.months[ol.months.length - 1].ym)} végén</span>
        </div>
      </div>

      {bars.length > 1 && (
        <div style={{ ...card, padding: '20px 22px 16px' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 14, gap: 12, flexWrap: 'wrap' }}>
            <span style={{ font: `700 15px ${FONT_H}`, color: C.navy }}>
              Egyenleg {bars.some((b) => b.kind === 'proj') ? '– tény és előrejelzés' : '– tény'}
            </span>
            <span style={{ display: 'flex', gap: 14, font: `400 12.5px ${FONT}`, color: C.muted }}>
              <span style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                <i style={{ width: 10, height: 10, borderRadius: 3, background: C.blue }} />
                tény
              </span>
              <span style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                <i style={{ width: 10, height: 10, borderRadius: 3, background: '#BFD8E8' }} />
                előrejelzés
              </span>
              hónap végi záró egyenleg
            </span>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: `repeat(${bars.length},minmax(0,1fr))`, gap: 8, alignItems: 'end', height: 160 }}>
            {bars.map((b, i) => (
              <div
                key={i}
                title={`${b.label}: ${fmt(b.v)} Ft`}
                style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'flex-end', gap: 6, height: '100%', minWidth: 0 }}
              >
                <span
                  style={{
                    font: `600 11px ${FONT}`,
                    color: b.v < 0 ? NEG : i === minIdx ? C.navy : C.muted,
                    fontVariantNumeric: 'tabular-nums',
                    whiteSpace: 'nowrap',
                  }}
                >
                  {fmtM(b.v)}
                </span>
                <div
                  style={{
                    width: '100%',
                    maxWidth: 64,
                    height: `${Math.max(3, Math.round((Math.abs(b.v) / maxV) * (hasNeg ? 70 : 78)))}%`,
                    background: b.v < 0 ? C.neg : i === minIdx ? C.navy : b.kind === 'actual' ? C.blue : '#BFD8E8',
                    borderRadius: '8px 8px 3px 3px',
                    transition: 'height .4s',
                    opacity: b.v < 0 ? 0.85 : 1,
                  }}
                />
                <span style={{ font: `600 12px ${FONT}`, color: b.cur ? C.navy : C.muted, whiteSpace: 'nowrap' }}>{b.label}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      <div style={{ ...card, overflow: 'auto', maxHeight: 'calc(100vh - 120px)' }}>
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: grid,
            minWidth: minW,
            background: '#fff',
            position: 'sticky',
            top: 0,
            zIndex: 3,
            borderBottom: `1px solid ${C.line}`,
          }}
        >
          <div style={{ position: 'sticky', left: 0, zIndex: 2, background: '#fff', padding: '12px 14px', ...eyebrow, borderRight: `1px solid ${C.line}` }}>
            Kategória
          </div>
          {cols.map((c) => (
            <div
              key={c.key}
              style={{
                padding: '12px',
                textAlign: 'right',
                background: c.kind === 'actual' ? C.bg3 : '#fff',
                display: 'flex',
                flexDirection: 'column',
                lineHeight: 1.2,
              }}
            >
              <span style={{ font: `700 12.5px ${FONT_H}`, color: C.navy }}>{c.label}</span>
              <span style={{ font: `500 11px ${FONT}`, color: C.muted }}>{c.sub}</span>
            </div>
          ))}
        </div>
        {/* összesítő sorok */}
        <Row
          grid={grid}
          minW={minW}
          bg={C.navy}
          border={C.navy}
          label="Összesített cashflow"
          labelStyle={{ font: `700 13.5px ${FONT_H}`, color: '#fff' }}
          h={rowH}
        >
          {matrix.balance.map((v, i) => (
            <Cell
              key={i}
              h={rowH}
              bg={cols[i].kind === 'actual' ? C.navy2 : 'transparent'}
              fg={v < 0 ? C.negLight : '#fff'}
              fw={700}
              title={matrix.balanceKind[i] === 'proj' ? 'előrejelzett záró egyenleg' : 'tényleges záró egyenleg'}
            >
              {fmt(v)}
            </Cell>
          ))}
        </Row>
        <Row
          grid={grid}
          minW={minW}
          bg={C.bg2}
          border={C.line2}
          label="Havi cashflow (bevétel − kiadás)"
          labelStyle={{ font: `600 13.5px ${FONT}`, color: C.navy }}
          h={rowH}
        >
          {netAll.map((v, i) => (
            <Cell
              key={i}
              h={rowH}
              bg={cols[i].kind === 'actual' ? '#E1ECF5' : 'transparent'}
              fg={!Math.round(v) ? C.muted : v < 0 ? NEG : '#2E7D4F'}
              fw={700}
            >
              {Math.round(v) > 0 ? '+' : ''}
              {fmt(v)}
            </Cell>
          ))}
        </Row>
        {matrix.rows.length === 0 && (
          <div style={{ padding: 30, textAlign: 'center', color: C.muted, font: `500 14px ${FONT}` }}>A szűrőknek megfelelő időszakban nincs tétel.</div>
        )}
        {matrix.rows.map((r) => {
          if (r.type === 'leaf' && (collapsed[r.groupId!] || collapsed[r.section])) return null;
          if (r.type === 'group' && collapsed[r.section]) return null;
          const isSec = r.type === 'section',
            isGroup = r.type === 'group';
          const bg = isSec ? C.bg : '#fff';
          const pad = isSec ? 8 : isGroup ? 22 : 44;
          const chev = collapsed[r.id] ? '▸' : '▾';
          return (
            <div
              key={r.type + r.id + (r.offerOnly ? ':o' : '')}
              style={{
                display: 'grid',
                gridTemplateColumns: grid,
                minWidth: minW,
                background: bg,
                borderTop: `1px solid ${isSec || isGroup ? C.line : C.line3}`,
              }}
            >
              <div
                style={{
                  position: 'sticky',
                  left: 0,
                  zIndex: 1,
                  background: bg,
                  display: 'flex',
                  alignItems: 'center',
                  gap: 6,
                  padding: `0 8px 0 ${pad}px`,
                  height: rowH,
                  borderRight: `1px solid ${C.line}`,
                }}
              >
                {r.type !== 'leaf' ? (
                  <button
                    onClick={() => setCollapsed((c) => ({ ...c, [r.id]: !c[r.id] }))}
                    style={{
                      width: 20,
                      height: 20,
                      border: 0,
                      background: 'transparent',
                      color: C.navy,
                      cursor: 'pointer',
                      font: `600 11px ${FONT}`,
                      padding: 0,
                    }}
                  >
                    {chev}
                  </button>
                ) : (
                  <span style={{ width: 20 }} />
                )}
                <span
                  onClick={() => (isGroup ? goGroup(r.id) : r.type === 'leaf' ? goGroup(r.groupId!) : undefined)}
                  style={{
                    flex: 1,
                    minWidth: 0,
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                    font: isSec ? `700 12.5px ${FONT_H}` : `${isGroup ? 600 : 400} 13.5px ${FONT}`,
                    color: isSec || isGroup ? C.navy : C.ink,
                    cursor: isSec ? 'default' : 'pointer',
                    textTransform: isSec ? 'uppercase' : undefined,
                  }}
                  title={r.label}
                >
                  {isGroup ? displayGroup(r.label) : r.label}
                </span>
                {canEdit && r.type !== 'section' && (
                  <button
                    className="add-btn"
                    title="Új tétel ide"
                    onClick={() => openNew(r.type === 'leaf' ? r.id : ix.leaves.find((l) => l.group_id === r.id && !l.archived)?.id || '')}
                    style={{
                      width: 24,
                      height: 24,
                      borderRadius: 999,
                      border: `1px solid ${C.line2}`,
                      background: '#fff',
                      color: C.blue,
                      cursor: 'pointer',
                      font: `600 15px/1 ${FONT}`,
                      padding: 0,
                      flex: 'none',
                    }}
                  >
                    +
                  </button>
                )}
              </div>
              {r.cells.map((c, i) => {
                const col = cols[i];
                const editable = canEdit && r.type === 'leaf' && !r.offerOnly && col.kind === 'plan' && col.months.length === 1 && col.last >= ix.cur;
                const isEd = editable && editing?.leaf === r.id && editing.col === i;
                const fg = c.v < 0 ? NEG : c.est ? C.muted : Math.round(c.v) === 0 ? C.faint : isSec || isGroup ? C.navy : C.ink;
                return (
                  <div
                    key={i}
                    onClick={() => (editable && !isEd ? setEditing({ leaf: r.id, col: i }) : isGroup && !editable ? goGroup(r.id) : undefined)}
                    title={c.est ? `ebből becslés: ${fmt(c.est)} Ft` : c.offer ? `ebből ajánlat: ${fmt(c.offer)} Ft` : undefined}
                    style={{
                      height: rowH,
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'flex-end',
                      padding: '0 12px',
                      background: isEd ? C.bg2 : col.kind === 'actual' ? (isSec ? '#EEF2F7' : C.bg3) : 'transparent',
                      color: fg,
                      font: `${isSec ? 700 : isGroup ? 600 : 400} 13.5px ${FONT}`,
                      fontStyle: c.est ? 'italic' : undefined,
                      fontVariantNumeric: 'tabular-nums',
                      cursor: editable ? 'text' : isGroup ? 'pointer' : 'default',
                      boxShadow: isEd ? `inset 0 0 0 2px ${C.blue}` : 'none',
                      whiteSpace: 'nowrap',
                    }}
                  >
                    {isEd ? (
                      <input
                        autoFocus
                        inputMode="numeric"
                        defaultValue={String(Math.round(c.v - c.est - c.offer) || '')}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') commitCell(r.id, i, (e.target as HTMLInputElement).value);
                          else if (e.key === 'Escape') setEditing(null);
                          else if (e.key === 'Tab') {
                            e.preventDefault();
                            commitCell(r.id, i, (e.target as HTMLInputElement).value);
                            if (i < cols.length - 1) setTimeout(() => setEditing({ leaf: r.id, col: i + 1 }), 0);
                          }
                        }}
                        onBlur={(e) => editing && commitCell(r.id, i, e.target.value)}
                        style={{
                          width: '100%',
                          textAlign: 'right',
                          border: 0,
                          outline: 0,
                          background: 'transparent',
                          font: `600 13.5px ${FONT}`,
                          color: C.navy,
                        }}
                      />
                    ) : (
                      cellText(c.v, c.est, c.offer)
                    )}
                  </div>
                );
              })}
            </div>
          );
        })}
      </div>
      <div style={{ font: `400 12px ${FONT}`, color: C.muted }}>
        ≈ dőlt: becslés az elmúlt 12 hónap tényei alapján · * ajánlatot tartalmaz · szürke háttér: tény (megtörtént) · csak a szűrőknek megfelelő, nem üres
        sorok látszanak
      </div>
    </div>
  );
}

function Row(p: {
  grid: string;
  minW: number;
  bg: string;
  border: string;
  label: string;
  labelStyle: React.CSSProperties;
  h: number;
  children: React.ReactNode;
}) {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: p.grid, minWidth: p.minW, background: p.bg, borderTop: `1px solid ${p.border}` }}>
      <div
        style={{
          position: 'sticky',
          left: 0,
          zIndex: 1,
          background: p.bg,
          display: 'flex',
          alignItems: 'center',
          padding: '0 8px 0 10px',
          height: p.h,
          borderRight: `1px solid ${p.border}`,
          ...p.labelStyle,
        }}
      >
        {p.label}
      </div>
      {p.children}
    </div>
  );
}

function Cell(p: { h: number; bg: string; fg: string; fw: number; children: React.ReactNode; title?: string }) {
  return (
    <div
      title={p.title}
      style={{
        height: p.h,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'flex-end',
        padding: '0 12px',
        background: p.bg,
        color: p.fg,
        font: `${p.fw} 13.5px ${FONT}`,
        fontVariantNumeric: 'tabular-nums',
        whiteSpace: 'nowrap',
      }}
    >
      {p.children}
    </div>
  );
}

/** Kijelentkezés: csak akkor sikeres, ha a szerver törölte a munkamenetet (401 = már nincs érvényes munkamenet). */
export async function logout(): Promise<void> {
  try {
    await api('/api/auth/logout', { body: {} });
  } catch (e) {
    if (e instanceof ApiError && e.status === 401) return;
    throw e;
  }
}
