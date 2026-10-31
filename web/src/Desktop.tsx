// Asztali nézet: oldalsáv + Áttekintés / Kategória / Tervezett bevételek, kiadások / Bank / Beállítások.
import { Fragment, useEffect, useMemo, useState } from 'react';
import { displayGroup } from '../../shared/categories';
import { buildMatrix, fmt, fmtM, monthLabel, monthLong, outlook, ymOf, type Matrix } from '../../shared/model';
import { useMergeCounts } from './MergeTabs';
import { AlertsView, useFlags } from './AlertsView';
import { api, ApiError } from './api';
import { BankView } from './BankView';
import { BreakevenView } from './BreakevenView';
import { CategoryView } from './CategoryView';
import type { EditTarget } from './EntryModal';
import { diffText, planLinks } from './LinkChain';
import { PartnerModal } from './PartnerModal';
import { PartnerRegistry } from './PartnerCard';
import { FilterBar, periodLabel } from './Filters';
import { PeriodPicker } from './PeriodPicker';
import { IncomeView } from './IncomeView';
import { setCellValue } from './logic';
import { SettingsView } from './SettingsView';
import { useStore } from './store';
import { APP_VERSION, VERSION_LABEL } from './version';
import { C, FONT, FONT_H, Pill, ToastView, card, eyebrow, relTime } from './ui';

export type View = 'overview' | 'alerts' | 'cat' | 'income' | 'bank' | 'partners' | 'breakeven' | 'settings';

export function Desktop({ onLogout }: { onLogout: () => void }) {
  const st = useStore();
  const { ix, data, filters, setFilters, toast, canEdit } = st;
  const [view, setView] = useState<View>(() => (new URLSearchParams(location.search).get('tab') === 'alerts' ? 'alerts' : 'overview'));
  // nézetváltáskor az oldal tetejére (a dokumentum görget)
  useEffect(() => {
    window.scrollTo({ top: 0 });
  }, [view, filters.groupId]);
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
  const mc = useMergeCounts();
  const newTx = data.bankTx.filter((t) => t.status === 'new').length;
  const openIncome = data.entries.filter((e) => e.kind === 'plan' && !e.done && ix.sectionOf(e.leaf_id) === 'in' && !e.tentative).length;
  // az oldalsáv mindig mutatja a bevételi és a kiadási kategóriákat is (a Bevétel/Kiadás szűrőtől függetlenül)
  const sideMatrix = useMemo(() => buildMatrix(ix, { ...filters, section: 'all', groupId: null, search: '' }), [ix, filters]);
  // az Ajánlatok mappa összege mindig az ajánlatokkal együtt (különben ajánlat-szűrő nélkül 0 lenne)
  const offerTotals = useMemo(() => {
    const m = buildMatrix(ix, { ...filters, section: 'all', groupId: null, search: '', includeOffers: true });
    return new Map(m.rows.filter((r) => r.type === 'group' && /aj[áa]nlat/i.test(r.label)).map((r) => [r.id, r.total]));
  }, [ix, filters]);
  const groupRows = sideMatrix.rows.filter((r) => r.type === 'group');
  const goGroup = (id: string) => {
    setFilters({ groupId: id });
    setView('cat');
  };
  const nav: [View, string, number][] = [
    ['overview', 'Áttekintés', 0],
    ['alerts', 'Összevonás', flags.length + mc.billingo + mc.bank + mc.names],
    ['income', 'Tervezett bevételek, kiadások', openIncome],
    ['bank', 'Bankszinkron', newTx],
    ['partners', 'Partnertörzs', 0],
    ['breakeven', 'Fedezeti pont', 0],
    ['settings', 'Beállítások', 0],
  ];

  return (
    <div style={{ display: 'grid', gridTemplateColumns: '256px minmax(0,1fr)', minHeight: '100vh', alignItems: 'start' }}>
      {/* az oldal (dokumentum) görget, nem egy belső doboz – a görgetős képernyőkép így az egész oldalt rögzíti; az oldalsáv rögzített */}
      <aside
        style={{ background: C.navy, color: '#fff', display: 'flex', flexDirection: 'column', overflow: 'auto', position: 'sticky', top: 0, height: '100vh' }}
      >
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
        {/* MOST: a mai nap és a hónapzárásig hátralévő napok */}
        {(() => {
          const t = data.today;
          const last = new Date(Date.UTC(Number(t.slice(0, 4)), Number(t.slice(5, 7)), 0)).getUTCDate();
          const left = last - Number(t.slice(8, 10));
          return (
            <div
              style={{ margin: '0 14px 14px', padding: '10px 12px', borderRadius: 10, background: C.navy3, display: 'flex', flexDirection: 'column', gap: 2 }}
            >
              <span style={{ font: `600 10px ${FONT}`, letterSpacing: '.14em', textTransform: 'uppercase', color: C.muted2 }}>Most</span>
              <b style={{ font: `700 15px ${FONT_H}`, color: '#fff' }}>
                {monthLong(ymOf(t))} {Number(t.slice(8, 10))}.
              </b>
              <span style={{ font: `500 11.5px ${FONT}`, color: C.blue2 }}>{left === 0 ? 'hónapzárás ma' : `hónapzárás ${left} nap múlva`}</span>
            </div>
          );
        })()}
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
                    <span style={{ font: `500 12px ${FONT}`, color: C.muted2, fontVariantNumeric: 'tabular-nums' }}>
                      {fmtM(offerTotals.get(g.id) ?? g.total)}
                    </span>
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

      <main style={{ position: 'relative', minWidth: 0 }}>
        {view === 'overview' && (
          <Overview
            matrix={matrix}
            netAll={sideMatrix.net}
            goBank={() => setView('bank')}
            goAlerts={() => setView('alerts')}
            goGroup={goGroup}
            openNew={(leaf) => setModal(leaf ? { leaf } : {})}
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
/**
 * Egy oszlop profitja (bevétel − kiadás). A folyó hónap terv-oszlopa a tény-oszloppal együtt egy hónap:
 * tény + terv, a már teljesült (tényhez kötött) terv nélkül.
 */
function colProfit(ix: ReturnType<typeof useStore>['ix'], matrix: Matrix, netAll: number[], i: number): number {
  const c = matrix.columns[i];
  let v = netAll[i];
  const prev = matrix.columns[i - 1];
  if (c.current && c.kind !== 'actual' && prev?.current && prev.kind === 'actual') {
    v += netAll[i - 1];
    for (const [leaf, mm] of ix.plan) for (const ym of c.months) v -= (mm.get(ym) || 0) - (ix.openPlan.get(leaf)?.get(ym) || 0);
  }
  return v;
}

type ChartBar = {
  label: string;
  v: number;
  kind: 'actual' | 'proj';
  cur: boolean;
  /** a hónap terve és ténye (profitnál: bevétel − kiadás) – a súgóban terv · tény · eltérés */
  plan?: number;
  act?: number | null;
  /** súgó-sor (pl. a folyó hónapnál: mai banki egyenleg − nyitott tételek = várható záró) */
  note?: string;
};

/** Havi oszlopdiagram nulla-vonallal (a negatív érték lefelé, pirosan). */
/** millió két tizedessel: 27,95 */
const m2 = (n: number) => (n / 1e6).toLocaleString('hu-HU', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const sgnM = (n: number) => (n > 0 ? '+' : n < 0 ? '−' : '') + (Math.abs(n) / 1e6).toLocaleString('hu-HU', { maximumFractionDigits: 1 });

/** Teendő-kártya az Áttekintés tetején: szám-pötty, cím, alcím, nyíl. */
function TaskCard(p: { n: number; title: string; sub: string; tone: 'blue' | 'red' | 'light' | 'pale'; onClick: () => void }) {
  const dot =
    p.tone === 'blue'
      ? { background: C.blue, color: '#fff' }
      : p.tone === 'red'
        ? { background: C.neg, color: '#fff' }
        : p.tone === 'light'
          ? { background: C.bg2, color: C.blueDark }
          : { background: C.bg, color: C.blueDark };
  return (
    <button
      type="button"
      className="hov-light"
      onClick={p.onClick}
      style={{ ...card, display: 'flex', alignItems: 'center', gap: 12, padding: '12px 14px', cursor: 'pointer', textAlign: 'left', width: '100%' }}
    >
      <span style={{ ...dot, width: 32, height: 32, flex: 'none', borderRadius: 999, display: 'grid', placeItems: 'center', font: `700 13px ${FONT_H}` }}>
        {p.n}
      </span>
      <span style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', lineHeight: 1.25 }}>
        <b style={{ font: `600 13.5px ${FONT}`, color: C.navy }}>{p.title}</b>
        <span style={{ font: `400 12px ${FONT}`, color: C.muted }}>{p.sub}</span>
      </span>
      <span style={{ font: `600 16px ${FONT}`, color: C.navy }}>›</span>
    </button>
  );
}

function HeroKpi(p: { label: string; value: string; sub: string; color?: string; boxed?: boolean }) {
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 4,
        padding: p.boxed ? '10px 12px' : '10px 0',
        borderRadius: 10,
        background: p.boxed ? C.bg2 : 'transparent',
        minWidth: 0,
      }}
    >
      <span style={{ ...eyebrow, fontSize: 10.5, color: p.boxed ? C.blueDark : C.muted }}>{p.label}</span>
      <span
        style={{
          font: `800 ${p.boxed ? 'clamp(20px,1.8vw,26px)' : 'clamp(19px,1.65vw,24px)'}/1.1 ${FONT_H}`,
          color: p.color || C.navy,
          fontVariantNumeric: 'tabular-nums',
          whiteSpace: 'nowrap',
        }}
      >
        {p.value}
      </span>
      {p.sub && <span style={{ font: `400 12px ${FONT}`, color: C.muted }}>{p.sub}</span>}
    </div>
  );
}

/** Egy grafikon: vonal = egyenleg hó végén, oszlop = havi eredmény (sötét = tény, világos = terv, piros = negatív). */
function ComboChart({ bars, profit }: { bars: ChartBar[]; profit: ChartBar[] }) {
  const n = bars.length;
  const [hov, setHov] = useState<number | null>(null);
  const LINE_H = 120;
  const BAR_H = 70;
  const vals = bars.map((b) => b.v);
  const lo = Math.min(...vals);
  const hi = Math.max(...vals);
  const pad = (hi - lo) * 0.15 || Math.abs(hi) * 0.02 || 1;
  const y = (v: number) => 100 - ((v - (lo - pad)) / (hi - lo + 2 * pad)) * 100;
  const maxAbs = Math.max(1, ...profit.map((b) => Math.abs(b.v)));
  const h = (v: number) => (Math.round(v) ? Math.max(4, Math.round((Math.abs(v) / maxAbs) * BAR_H)) : 0);
  const negMax = Math.max(0, ...profit.map((b) => (b.v < 0 ? h(b.v) : 0)));
  const pts = bars.map((b, i) => `${((i + 0.5) / n) * 100},${y(b.v)}`).join(' ');
  const sg = (v: number, cur: boolean) =>
    (v > 0 ? '+' : v < 0 ? '−' : '') + (Math.abs(v) / 1e6).toLocaleString('hu-HU', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + (cur ? ' M' : '');
  const hb = hov != null ? { bal: bars[hov], pr: profit[hov] } : null;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 6 }}>
      <div style={{ position: 'relative', height: LINE_H + BAR_H + negMax + 8 }} onMouseLeave={() => setHov(null)}>
        <svg
          viewBox="0 0 100 100"
          preserveAspectRatio="none"
          style={{ position: 'absolute', left: 0, top: 0, width: '100%', height: LINE_H, overflow: 'visible' }}
        >
          <polyline points={pts} fill="none" stroke={C.navy} strokeWidth={2.5} vectorEffect="non-scaling-stroke" strokeLinejoin="round" />
        </svg>
        <div style={{ position: 'absolute', left: 0, right: 0, top: LINE_H + BAR_H, borderTop: `1px solid ${C.line}` }} />
        <div style={{ position: 'absolute', inset: 0, display: 'grid', gridTemplateColumns: `repeat(${n},1fr)` }}>
          {profit.map((b, i) => {
            const neg = b.v < 0;
            const dark = b.cur || b.kind === 'actual';
            const bg = neg ? '#E8A497' : dark ? C.blue : '#C3DAEA';
            return (
              <div
                key={i}
                onMouseEnter={() => setHov(i)}
                style={{ position: 'relative', cursor: 'default', background: hov === i ? 'rgba(0,32,64,.03)' : undefined }}
              >
                <div
                  style={{
                    position: 'absolute',
                    left: '22%',
                    right: '22%',
                    top: neg ? LINE_H + BAR_H : LINE_H + BAR_H - h(b.v),
                    height: h(b.v),
                    background: bg,
                    borderRadius: neg ? '0 0 3px 3px' : '3px 3px 0 0',
                  }}
                />
              </div>
            );
          })}
        </div>
        {hb && (
          <div
            style={{
              position: 'absolute',
              top: 0,
              left: `${Math.min(70, ((hov! + 0.5) / n) * 100)}%`,
              transform: 'translateX(-50%)',
              background: '#fff',
              border: `1px solid ${C.line}`,
              borderRadius: 8,
              padding: '6px 10px',
              font: `500 12px ${FONT}`,
              color: C.ink,
              boxShadow: '0 4px 14px rgba(0,32,64,.12)',
              whiteSpace: 'nowrap',
              pointerEvents: 'none',
              fontVariantNumeric: 'tabular-nums',
            }}
          >
            <b style={{ color: C.navy }}>{hb.bal.label}</b> · egyenleg hó végén {fmt(hb.bal.v)} Ft · havi eredmény {hb.pr.v > 0 ? '+' : ''}
            {fmt(hb.pr.v)} Ft
          </div>
        )}
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: `repeat(${n},1fr)`, textAlign: 'center' }}>
        {profit.map((b, i) => (
          <div key={i} style={{ display: 'flex', flexDirection: 'column', lineHeight: 1.3 }}>
            <span style={{ font: `${b.cur ? 700 : 500} 12.5px ${FONT}`, color: b.cur ? C.navy : C.muted }}>{b.label}</span>
            <span style={{ font: `500 12px ${FONT}`, color: b.v < 0 ? NEG_C : C.blueDark, fontVariantNumeric: 'tabular-nums' }}>{sg(b.v, i === 0)}</span>
          </div>
        ))}
      </div>
      <div style={{ display: 'flex', gap: 18, flexWrap: 'wrap', font: `400 12px ${FONT}`, color: C.muted, marginTop: 4 }}>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          <i style={{ width: 18, height: 2.5, background: C.navy, display: 'inline-block' }} /> egyenleg hó végén
        </span>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          <i style={{ width: 10, height: 10, borderRadius: 2, background: C.blue, display: 'inline-block' }} /> havi eredmény (tény)
        </span>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          <i style={{ width: 10, height: 10, borderRadius: 2, background: '#C3DAEA', display: 'inline-block' }} /> terv
        </span>
      </div>
    </div>
  );
}
const NEG_C = C.neg;
/** eltérés színe: kék = jó irány, piros = rosszabb a tervnél */
const devColor = (sec: string | undefined, diff: number) => (!diff ? C.muted : diff > 0 === (sec !== 'out') ? C.blueDark : C.neg);

/** Eltérés a tervtől az aktuális hónapban: lezárt (tényhez kötött) tervek, ahol a tény eltért. */
function DeviationPanel() {
  const { data, ix, openPartner } = useStore();
  const [all, setAll] = useState(false);
  const rows = useMemo(() => {
    const links = planLinks(data.entries, () => true).filter((l) => l.actual && ymOf(l.actual.date) === ix.cur && l.diff);
    const by = new Map<string, { leaf: string; diff: number; plan: number; act: number }>();
    for (const l of links) {
      const r = by.get(l.plan.leaf_id) || { leaf: l.plan.leaf_id, diff: 0, plan: 0, act: 0 };
      r.diff += l.diff!;
      r.plan += Math.abs(l.plan.amount);
      r.act += Math.abs(l.actual!.amount);
      by.set(l.plan.leaf_id, r);
    }
    return [...by.values()].sort((a, b) => Math.abs(b.diff) - Math.abs(a.diff));
  }, [data.entries, ix.cur]);
  const tot = (sec: 'in' | 'out') => rows.filter((r) => ix.sectionOf(r.leaf) === sec).reduce((a, r) => a + r.diff, 0);
  return (
    <div style={{ ...card, minWidth: 0, padding: '18px 20px 14px', display: 'flex', flexDirection: 'column' }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 10 }}>
        <b style={{ flex: 1, font: `700 16px ${FONT_H}`, color: C.navy }}>Eltérés a tervtől · {monthLabel(ix.cur).toLowerCase()}</b>
        {rows.length > 4 && (
          <button
            onClick={() => setAll(!all)}
            style={{ border: 0, background: 'transparent', color: C.blue, font: `600 12.5px ${FONT}`, cursor: 'pointer', padding: 0 }}
          >
            {all ? 'Kevesebb ‹' : `Mind (${rows.length}) ›`}
          </button>
        )}
      </div>
      <div
        style={{
          display: 'flex',
          gap: 14,
          font: `500 13px ${FONT}`,
          color: C.muted,
          margin: '8px 0 6px',
          paddingBottom: 10,
          borderBottom: `1px solid ${C.line}`,
        }}
      >
        <span>
          Bevétel <b style={{ color: devColor('in', tot('in')), marginLeft: 6 }}>{diffText(tot('in'))}</b>
        </span>
        <span>
          Kiadás <b style={{ color: devColor('out', tot('out')), marginLeft: 6 }}>{diffText(tot('out'))}</b>
        </span>
      </div>
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column' }}>
        {rows.length === 0 && (
          <span style={{ font: `500 13px ${FONT}`, color: C.muted, padding: '10px 0' }}>Ebben a hónapban minden lezárt tétel a terv szerint teljesült.</span>
        )}
        {(all ? rows : rows.slice(0, 4)).map((r, i) => {
          const sec = ix.sectionOf(r.leaf);
          return (
            <button
              key={r.leaf}
              onClick={() => openPartner(r.leaf)}
              className="hov-light"
              style={{
                display: 'flex',
                gap: 10,
                alignItems: 'center',
                border: 0,
                borderTop: i ? `1px solid ${C.line3}` : 0,
                background: 'transparent',
                padding: '10px 0',
                cursor: 'pointer',
                textAlign: 'left',
              }}
            >
              <span style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', lineHeight: 1.3 }}>
                <b style={{ font: `600 14px ${FONT}`, color: C.navy, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {ix.leafById[r.leaf]?.label}
                </b>
                <span style={{ font: `400 12px ${FONT}`, color: C.muted }}>
                  {sec === 'out' ? 'kiadás · ' : 'terv '}
                  {fmt(r.plan)} → {fmt(r.act)}
                </span>
              </span>
              <b style={{ font: `700 14px ${FONT}`, color: devColor(sec, r.diff), fontVariantNumeric: 'tabular-nums' }}>{diffText(r.diff)}</b>
            </button>
          );
        })}
      </div>
      <span style={{ font: `400 11.5px ${FONT}`, color: C.muted, marginTop: 10 }}>kék = jó irány · piros = rosszabb a tervnél</span>
    </div>
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
  const [showFilters, setShowFilters] = useState(false);
  const mc = useMergeCounts();
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
  const { bars, profitBars } = useMemo(() => {
    const bal: ChartBar[] = [];
    const pr: ChartBar[] = [];
    cols.forEach((c, i) => {
      if (c.current && c.kind === 'actual' && cols[i + 1]?.current) return;
      const label = filters.granularity === 'year' ? c.label : monthLabel(c.last);
      // folyó hónap: a záró egyenleg előrejelzés (mai banki egyenleg ± a hónap még nyitott tételei) – nem tény
      const curOpen = c.current && matrix.balanceKind[i] === 'proj';
      bal.push({
        label,
        v: matrix.balance[i],
        kind: matrix.balanceKind[i],
        cur: c.current,
        note: curOpen
          ? `ma a bankban ${fmt(ix.anchor)} Ft · még nyitott tételek ${matrix.balance[i] - ix.anchor > 0 ? '+' : '−'}${fmt(Math.abs(matrix.balance[i] - ix.anchor))} Ft · várható záró ${fmt(matrix.balance[i])} Ft`
          : `${matrix.balanceKind[i] === 'actual' ? 'tény' : 'előrejelzés'}: ${fmt(matrix.balance[i])} Ft`,
      });
      // a hónap(ok) terve (minden biztos terv, a teljesültek is) és ténye: bevétel − kiadás
      const sumIx = (m: Map<string, Map<string, number>>) => c.months.reduce((a, ym) => a + [...m.values()].reduce((x, mm) => x + (mm.get(ym) || 0), 0), 0);
      const past = c.months[0] <= ix.cur;
      pr.push({
        label,
        v: colProfit(ix, matrix, netAll, i),
        kind: c.kind === 'actual' || (!c.current && c.last < ix.cur) ? 'actual' : 'proj',
        cur: c.current,
        plan: sumIx(ix.plan),
        act: past ? sumIx(ix.actual) : null,
      });
    });
    return { bars: bal.slice(-24), profitBars: pr.slice(-24) };
  }, [cols, matrix, netAll, ix, filters.granularity]);

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
    return fmt(v) + (offer ? ' *' : '');
  };

  // a folyó hónap tény + terv oszlopai a táblázatban egy „2026. október” fül alatt
  const curIdx = cols.map((c, i) => (c.current ? i : -1)).filter((i) => i >= 0);
  const overdueN = flags.filter((f) => f.kind === 'overdue').length;
  const uninvN = flags.filter((f) => f.kind === 'uninvoiced').length;
  const dupN = mc.billingo + mc.bank + mc.names;
  const curName = monthLong(ix.cur).replace(/^\d+\.\s*/, '');
  const leafCount = useMemo(() => {
    const m = new Map<string, number>();
    matrix.rows.forEach((r) => r.type === 'leaf' && r.groupId && m.set(r.groupId, (m.get(r.groupId) || 0) + 1));
    return m;
  }, [matrix.rows]);
  const nextBal = ol.next12.endBal;

  return (
    <div style={{ padding: '24px 28px 120px', display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 14, flexWrap: 'wrap' }}>
        <h1 style={{ margin: 0, font: `800 30px/1.05 ${FONT_H}`, color: C.navy, letterSpacing: '-.01em' }}>
          Cashflow <span style={{ font: `500 15px ${FONT}`, color: C.muted, letterSpacing: 0 }}>· {monthLong(ix.cur)}</span>
        </h1>
        <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
          <PeriodPicker label={periodLabel(filters, ix.cur, ix.firstActual)} />
          <button
            type="button"
            onClick={() => st.setFilters({ includeOffers: !filters.includeOffers })}
            title="A még el nem fogadott ajánlatok beszámítása"
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 8,
              border: `1px solid ${C.line2}`,
              borderRadius: 999,
              background: '#fff',
              padding: '8px 14px 8px 10px',
              font: `600 13px ${FONT}`,
              color: C.navy,
              cursor: 'pointer',
            }}
          >
            <span
              style={{
                width: 30,
                height: 18,
                borderRadius: 999,
                background: filters.includeOffers ? C.blue : C.line2,
                position: 'relative',
                transition: 'background .15s',
              }}
            >
              <span
                style={{
                  position: 'absolute',
                  top: 2,
                  left: filters.includeOffers ? 14 : 2,
                  width: 14,
                  height: 14,
                  borderRadius: 999,
                  background: '#fff',
                  transition: 'left .15s',
                }}
              />
            </span>
            Ajánlatokkal
          </button>
          <input
            value={filters.search}
            onChange={(e) => st.setFilters({ search: e.target.value })}
            placeholder="Keresés…"
            style={{ border: `1px solid ${C.line2}`, borderRadius: 999, padding: '9px 16px', font: `500 13px ${FONT}`, width: 200, outline: 'none' }}
          />
          {canEdit && (
            <button
              type="button"
              className="hov-primary"
              onClick={() => openNew('')}
              style={{ border: 0, borderRadius: 999, background: C.blue, color: '#fff', padding: '10px 18px', font: `600 13.5px ${FONT}`, cursor: 'pointer' }}
            >
              + Új tétel
            </button>
          )}
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,minmax(0,1fr))', gap: 12 }}>
        <TaskCard n={newTx} title="Banki tétel párosításra" sub="javaslat kész" tone="blue" onClick={goBank} />
        <TaskCard n={overdueN} title="Elmaradt terv" sub="lejárt, nincs tény" tone="red" onClick={goAlerts} />
        <TaskCard n={uninvN} title="Kiszámlázandó" sub={`${curName}i tervek`} tone="light" onClick={goAlerts} />
        <TaskCard n={dupN} title="Lehetséges duplikáció" sub="összevonásra vár" tone="pale" onClick={goAlerts} />
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0,1fr) minmax(260px,330px)', gap: 14, alignItems: 'stretch' }}>
        <div style={{ ...card, minWidth: 0, padding: '18px 22px 16px', display: 'flex', flexDirection: 'column', gap: 10 }}>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(170px,1fr))', gap: 12 }}>
            <HeroKpi label="Ma · bankban" value={fmt(ix.anchor)} sub="" />
            <HeroKpi
              boxed
              label={`Havi cashflow · ${monthLabel(ix.cur).toLowerCase()}`}
              value={(curOl.net > 0 ? '+' : curOl.net < 0 ? '−' : '') + fmt(Math.abs(curOl.net))}
              color={curOl.net < 0 ? NEG : C.blueDark}
              sub={`hó vége: ${fmt(curOl.bal)}`}
            />
            <HeroKpi
              label="Mélypont"
              value={m2(ol.next12.minBal) + ' M'}
              color={ol.next12.minBal < 0 ? NEG : undefined}
              sub={`${monthLabel(ol.next12.minYm).toLowerCase()} vége`}
            />
            <HeroKpi label="12 hó múlva" value={m2(nextBal) + ' M'} color={nextBal < 0 ? NEG : undefined} sub={`nettó ${sgnM(nextBal - curOl.bal)} M`} />
          </div>
          {bars.length > 1 && <ComboChart bars={bars} profit={profitBars} />}
        </div>
        <DeviationPanel />
      </div>

      {showFilters && <FilterBar />}

      <div style={{ ...card, overflowX: 'auto' }}>
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, padding: '10px 12px 0', flexWrap: 'wrap' }}>
          {canEdit && (
            <span style={{ font: `400 12px ${FONT}`, color: C.muted, alignSelf: 'center', marginRight: 'auto' }}>
              Terv cellára kattintva módosíthatsz · Enter = mentés
            </span>
          )}
          <Pill small onClick={() => setShowFilters(!showFilters)}>
            {showFilters ? 'Szűrők elrejtése' : 'További szűrők'}
          </Pill>
          <Pill small onClick={() => setDense(!dense)}>
            {dense ? 'Kényelmes' : 'Kompakt'}
          </Pill>
          <Pill
            small
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
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: grid,
            minWidth: minW,
            background: '#fff',
            position: 'sticky',
            top: 0,
            zIndex: 3,
            paddingTop: 10,
          }}
        >
          <div
            style={{
              gridColumn: 1,
              gridRow: '1 / span 2',
              position: 'sticky',
              left: 0,
              zIndex: 2,
              background: '#fff',
              padding: '0 14px 10px',
              display: 'flex',
              alignItems: 'flex-end',
              ...eyebrow,
            }}
          >
            Kategória
          </div>
          {curIdx.length > 0 && (
            <div
              style={{
                gridColumn: `${curIdx[0] + 2} / span ${curIdx.length}`,
                gridRow: 1,
                background: C.navy,
                color: '#fff',
                borderRadius: '8px 8px 0 0',
                textAlign: 'center',
                padding: '8px 0',
                font: `700 13px ${FONT_H}`,
              }}
            >
              {filters.granularity === 'year' ? cols[curIdx[0]].label : monthLong(ix.cur)}
            </div>
          )}
          {cols.map((c, i) => (
            <div
              key={c.key}
              title={c.sub}
              style={{
                gridColumn: i + 2,
                gridRow: 2,
                padding: '10px 12px',
                textAlign: 'right',
                background: c.current ? '#EEF4F9' : '#fff',
                font: `700 13px ${FONT_H}`,
                color: C.navy,
              }}
            >
              {c.current && curIdx.length > 1 ? (c.kind === 'actual' ? 'Tény' : 'Terv') : c.label}
            </div>
          ))}
        </div>
        {/* összesítő sorok */}
        <Row
          grid={grid}
          minW={minW}
          bg="#EEF4F9"
          border={C.line}
          label="Havi cashflow"
          labelStyle={{ font: `700 15px ${FONT_H}`, color: C.navy, paddingLeft: 30 }}
          h={rowH + 16}
        >
          {netAll.map((v, i) => (
            <Cell
              key={i}
              h={rowH + 16}
              bg={cols[i].current ? '#E1ECF5' : 'transparent'}
              fg={!Math.round(v) ? C.muted : v < 0 ? NEG : C.blueDark}
              fw={700}
              size={15}
            >
              {Math.round(v) > 0 ? '+' : Math.round(v) < 0 ? '−' : ''}
              {fmt(Math.abs(v))}
            </Cell>
          ))}
        </Row>
        <Row
          grid={grid}
          minW={minW}
          bg={C.navy}
          border={C.navy}
          label="Egyenleg hó végén"
          labelStyle={{ font: `700 14px ${FONT_H}`, color: '#fff', paddingLeft: 30 }}
          h={rowH + 8}
        >
          {matrix.balance.map((v, i) => (
            <Cell
              key={i}
              h={rowH + 8}
              bg={cols[i].current ? C.navy2 : 'transparent'}
              fg={v < 0 ? C.negLight : '#fff'}
              fw={700}
              title={matrix.balanceKind[i] === 'proj' ? 'előrejelzett záró egyenleg' : 'tényleges záró egyenleg'}
            >
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
                  {isGroup && (leafCount.get(r.id) || 0) > 0 && (
                    <span style={{ font: `400 11.5px ${FONT}`, color: C.faint, marginLeft: 6 }}>{leafCount.get(r.id)} tétel</span>
                  )}
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
                const fg = c.v < 0 ? NEG : c.est ? C.faint : Math.round(c.v) === 0 ? C.faint : isSec || isGroup ? C.navy : C.ink;
                // folyó hónap tény-cellája: pötty, ha eltér a hónap tervétől (kék = jó irány, piros = rosszabb)
                const planCell = col.current && col.kind === 'actual' && cols[i + 1]?.current ? r.cells[i + 1] : null;
                const dev =
                  planCell && !isSec && Math.round(c.v) && Math.round(Math.abs(c.v) - Math.abs(planCell.v)) ? Math.abs(c.v) - Math.abs(planCell.v) : 0;
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
                      background: isEd ? C.bg2 : col.current ? (isSec ? '#EEF2F7' : '#F7FAFC') : 'transparent',
                      color: fg,
                      font: `${isSec ? 700 : isGroup ? 600 : 400} 13.5px ${FONT}`,
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
                      <>
                        {dev ? (
                          <span style={{ width: 6, height: 6, borderRadius: 999, background: devColor(r.section, dev), marginRight: 7, flex: 'none' }} />
                        ) : null}
                        {cellText(c.v, c.est, c.offer)}
                      </>
                    )}
                  </div>
                );
              })}
            </div>
          );
        })}
        <div
          style={{
            display: 'flex',
            gap: 18,
            flexWrap: 'wrap',
            padding: '10px 14px',
            borderTop: `1px solid ${C.line}`,
            font: `400 12px ${FONT}`,
            color: C.muted,
            minWidth: minW,
          }}
        >
          <span>
            {monthLabel(ix.cur)}: <b style={{ color: C.navy }}>tény</b> = bankból · <b style={{ color: C.navy }}>terv</b> = rögzített
          </span>
          <span>
            <b style={{ color: C.ink }}>fekete</b> = terv
          </span>
          <span style={{ color: C.faint }}>szürke = becslés (múlt 12 hó alapján)</span>
          <span>
            <span style={{ color: C.neg }}>●</span> eltérés a tervtől
          </span>
          <span>* ajánlatot tartalmaz · üres sorok elrejtve</span>
        </div>
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

function Cell(p: { h: number; bg: string; fg: string; fw: number; children: React.ReactNode; title?: string; size?: number }) {
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
        font: `${p.fw} ${p.size || 13.5}px ${FONT}`,
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
