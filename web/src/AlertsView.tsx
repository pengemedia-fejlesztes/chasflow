// Összevonás: a terv, a számla (Billingo / NAV) és a tény (bank) összekötésének teendői fülekre bontva –
// nincs kiszámlázva, új számla terv nélkül (hova sorolta a rendszer), elmaradás a tervhez képest, kategóriába sorolt
// NAV-számlák, be nem azonosított banki tételek, és az egy partnerhez tartozó nevek összevonása.
import { useEffect, useMemo, useState } from 'react';
import { normalizeText } from '../../shared/categories';
import { billingFlags, computeFlags, flagsFrom, FLAG_LABEL, type Flag, type FlagKind } from '../../shared/flags';
import { DEFAULT_PAY_DAYS } from '../../shared/workdays';
import { addMonths, fmt, monthLong, ymOf } from '../../shared/model';
import { unplannedHint } from '../../shared/unplanned';
import { LeafPicker } from './LeafPicker';
import { genSeries } from './logic';
import { targetTracking } from '../../shared/insights';
import type { Entry, NavInvoice } from '../../shared/types';
import { api } from './api';
import { PartnerLink } from './PartnerCard';
import { MergeBank, MergeBillingo, MergeNames, useMergeCounts } from './MergeTabs';
import { useStore } from './store';
import { C, FONT, FONT_H, Modal, Pill, card } from './ui';

export function useFlags(): Flag[] {
  const { data, ix } = useStore();
  return useMemo(() => {
    let ack: string[] = [];
    try {
      ack = JSON.parse(data.settings.flags_ack || '[]');
    } catch {}
    const bank = computeFlags(data.entries, data.bankTx, ix.sectionOf, data.today, ack);
    // NAV: bejövő számla, amihez nincs terv (még a kifizetés előtt szól)
    const inv: Flag[] = (data.navInvoices || [])
      .filter((n) => n.status === 'new')
      .map((n) => ({
        id: `inv:${n.id}`,
        kind: 'invoice',
        section: 'out',
        date: n.payment_date || n.issue_date || data.today,
        name: n.partner_name || n.invoice_number,
        leaf_id: n.leaf_id || '',
        amount: n.gross,
        entry_id: '',
        nav: n,
      }));
    // számlázás ellenőrzése (csak ha van Billingo): nincs kiszámlázva / kevesebb a számla
    const bill = data.integrations.billingo
      ? billingFlags(data.entries, ix.sectionOf, data.today, (l) => ix.leafById[l]?.pay_days ?? DEFAULT_PAY_DAYS, flagsFrom(data.entries, data.today), ack)
      : [];
    const notInvoiced = new Set(bill.filter((f) => f.kind === 'uninvoiced').map((f) => f.entry_id));
    // ami nincs kiszámlázva, az nem „elmaradt befizetés” – egy riasztás elég
    const flags = [...inv, ...bill, ...bank.filter((f) => !(f.kind === 'overdue' && notInvoiced.has(f.entry_id)))];
    // havi eredmény-cél: az előző (lezárt) hónap ténye és a folyó hónap várható eredménye
    const target = Number(data.settings.profit_target || 0);
    if (target) {
      const tf: Flag[] = targetTracking(ix, target, [addMonths(ix.cur, -1), ix.cur])
        .filter((t) => !t.ok)
        .map((t) => ({
          id: `tgt:${t.ym}:${Math.round(t.net / 1000)}`,
          kind: 'target',
          section: 'in',
          date: t.ym + '-01',
          name: `${monthLong(t.ym)} – ${t.forecast ? 'várható' : 'tény'} eredmény`,
          leaf_id: '',
          amount: t.net,
          plan: target,
          diff: t.gap,
          entry_id: '',
        }));
      return [...tf.filter((f) => !ack.includes(f.id)), ...flags];
    }
    return flags;
  }, [data.entries, data.bankTx, data.navInvoices, data.settings.flags_ack, data.settings.profit_target, data.today, ix]);
}

type MergeTab = 'bill' | 'new' | 'gap' | 'nav' | 'bank' | 'names';
/** melyik riasztás melyik fülön */
const TAB_KINDS: Record<MergeTab, FlagKind[]> = {
  bill: ['uninvoiced', 'underbilled'],
  new: ['invoice'],
  gap: ['target', 'overdue', 'deviation', 'unplanned'],
  nav: [],
  bank: [],
  names: [],
};

const ft = (n: number) => (n > 0 ? '+' : n < 0 ? '−' : '') + fmt(Math.abs(n)) + ' Ft';
const dot = (d: string) => d.replace(/-/g, '.') + '.';

/** A tervhez tartozó, még nyitott jövőbeli tervek (azonos sorozat, vagy azonos kategória + név + összeg). */
function futurePlans(entries: Entry[], plan: Entry | undefined, after: string): Entry[] {
  if (!plan) return [];
  return entries.filter(
    (e) =>
      e.kind === 'plan' &&
      !e.done &&
      e.id !== plan.id &&
      e.date > after &&
      (plan.series_id ? e.series_id === plan.series_id : e.leaf_id === plan.leaf_id && e.name === plan.name && e.amount === plan.amount),
  );
}

export function AlertsView({ mobile }: { mobile?: boolean }) {
  const st = useStore();
  const { data, ix, canEdit, run, commit } = st;
  const flags = useFlags();
  const counts = useMergeCounts();
  const [invoice, setInvoice] = useState<string | null>(null);
  // „Nem kell terv” jelölt (kézzel kezelt) bejövő számlák – visszanézhetők, visszanyithatók
  const [showIgnored, setShowIgnored] = useState(false);
  const ignoredNav = (data.navInvoices || []).filter((n) => n.status === 'ignored' && (n.operation || 'CREATE') === 'CREATE');
  // kategóriába sorolt (tervbe vett) NAV-számlák – a legfrissebb elöl, módosíthatók
  const [showPlanned, setShowPlanned] = useState(true);
  const plannedNav = (data.navInvoices || [])
    .filter((n) => (n.status === 'planned' || n.status === 'paid') && (n.operation || 'CREATE') === 'CREATE')
    .sort((a, b) => (b.issue_date || '').localeCompare(a.issue_date || ''));
  const byId = useMemo(() => new Map(data.entries.map((e) => [e.id, e])), [data.entries]);
  const from = flagsFrom(data.entries, data.today);
  const unforeseen = ix.leaves.find((l) => !l.archived && ix.sectionOf(l.id) === 'out' && normalizeText(l.label).startsWith('elore nem lathato'))?.id ?? null;

  const ack = (ids: string[], msg: string) =>
    run(
      () => api('/api/flags/ack', { body: { ids } }),
      msg,
      () => api('/api/flags/ack', { body: { ids, undo: true } }),
    );

  const groups: [FlagKind, string][] = [
    ['target', 'A havi eredmény (bevétel − kiadás) elmarad a beállított céltól.'],
    ['uninvoiced', 'A terv szerinti számlázási nap (fizetés − fizetési határidő) elmúlt, de nincs hozzá Billingo-számla.'],
    ['underbilled', 'A kiállított számla kevesebb, mint a terv. (Ha több, nincs riasztás.)'],
    ['invoice', 'A NAV-ba beérkezett szállítói számla, amihez nincs terv. Döntsd el: rendszeres (havonta tervbe) vagy előre nem látható költség.'],
    ['deviation', 'A tény más összeggel érkezett, mint a terv.'],
    ['unplanned', 'Nem volt rá terv. Ha ismétlődik, vedd fel havonta a tervbe; ha egyszeri, az előre nem látható költségek közé kerül.'],
    ['overdue', 'A terv dátuma elmúlt, de nem érkezett hozzá banki tény.'],
  ];

  const navCount = plannedNav.length + ignoredNav.length;
  const tabs: [MergeTab, string, number][] = [
    ['bill', 'Nincs kiszámlázva', flags.filter((f) => TAB_KINDS.bill.includes(f.kind)).length],
    ['new', 'Új számla, nincs terv', flags.filter((f) => TAB_KINDS.new.includes(f.kind)).length + counts.billingo],
    ['gap', 'Elmaradás a tervtől', flags.filter((f) => TAB_KINDS.gap.includes(f.kind)).length],
    ['nav', 'NAV-számlák', 0],
    ['bank', 'Bankszinkron', counts.bank],
    ['names', 'Partnernevek', counts.names],
  ];
  const [tab, setTabS] = useState<MergeTab>(() => {
    try {
      const v = localStorage.getItem('cf_merge_tab') as MergeTab | null;
      if (v && v in TAB_KINDS) return v;
    } catch {}
    return 'bill';
  });
  const setTab = (t: MergeTab) => {
    setTabS(t);
    try {
      localStorage.setItem('cf_merge_tab', t);
    } catch {}
  };
  const tabFlags = flags.filter((f) => TAB_KINDS[tab].includes(f.kind));

  const pad = mobile ? '14px 16px 24px' : '28px 32px 120px';
  return (
    <div style={{ padding: pad, display: 'flex', flexDirection: 'column', gap: 16, maxWidth: 980 }}>
      {invoice && <NavInvoiceModal number={invoice} onClose={() => setInvoice(null)} />}
      {!mobile && (
        <div>
          <div style={{ font: `600 12px ${FONT}`, letterSpacing: '.18em', textTransform: 'uppercase', color: C.neg, marginBottom: 8 }}>Összevonás</div>
          <h1 style={{ margin: 0, font: `700 30px/1.05 ${FONT_H}`, color: C.navy }}>Terv – számla – tény</h1>
          <p style={{ margin: '10px 0 0', font: `400 14px/1.5 ${FONT}`, color: C.muted, maxWidth: '70ch' }}>
            A terv a tiéd. A kiállított (Billingo) és a beérkezett (NAV) számla a terv alá kerül, ez a friss becslés; a bank tétele a tény. Itt látod, mi nem
            állt még össze.
          </p>
        </div>
      )}
      <div
        style={{
          display: 'flex',
          gap: 6,
          flexWrap: mobile ? 'nowrap' : 'wrap',
          overflowX: mobile ? 'auto' : undefined,
          margin: mobile ? '0 -16px' : undefined,
          padding: mobile ? '0 16px 2px' : undefined,
        }}
      >
        {tabs.map(([k, label, n]) => (
          <button
            key={k}
            onClick={() => setTab(k)}
            style={{
              flex: 'none',
              height: 36,
              borderRadius: 999,
              padding: '0 14px',
              border: tab === k ? 0 : `1.5px solid ${C.line2}`,
              background: tab === k ? C.navy : '#fff',
              color: tab === k ? '#fff' : C.ink,
              font: `600 13px ${FONT}`,
              cursor: 'pointer',
              whiteSpace: 'nowrap',
            }}
          >
            {label}
            {k === 'nav' ? (
              <span style={{ opacity: 0.7 }}> {navCount}</span>
            ) : n > 0 ? (
              <span style={{ marginLeft: 6, padding: '1px 7px', borderRadius: 999, background: C.neg, color: '#fff', font: `700 11px ${FONT}` }}>{n}</span>
            ) : null}
          </button>
        ))}
      </div>
      {tab === 'bank' && <MergeBank mobile={mobile} />}
      {tab === 'names' && <MergeNames />}
      {tab === 'new' && <MergeBillingo />}
      {(tab === 'gap' || tab === 'bill' || tab === 'new') && (
        <span style={{ font: `400 13px/1.5 ${FONT}`, color: C.muted }}>
          Figyelt időszak: {dot(from)} – ma. Eltérésnek számít, ha a tény legalább 1 000 Ft-tal (és 1%-kal) más, mint a terv. A „Rendben” mindkettőtöknél
          eltünteti a riasztást.
        </span>
      )}
      {tab === 'new' && !tabFlags.length && !counts.billingo && (
        <div style={{ ...card, padding: '22px 20px', font: `600 14px ${FONT}`, color: C.blueDark }}>✓ Minden új számlához van terv.</div>
      )}
      {(tab === 'gap' || tab === 'bill') && !tabFlags.length && (
        <div style={{ ...card, padding: '22px 20px', font: `600 14px ${FONT}`, color: C.blueDark }}>
          {tab === 'bill' ? '✓ Minden esedékes terv ki van számlázva.' : '✓ Nincs elmaradás – minden tény a terv szerint alakult.'}
        </div>
      )}
      {groups.map(([kind, help]) => {
        const fs = tabFlags.filter((f) => f.kind === kind);
        if (!fs.length) return null;
        return (
          <section key={kind} style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, flexWrap: 'wrap' }}>
              <span style={{ font: `700 16px ${FONT_H}`, color: C.navy }}>
                {FLAG_LABEL[kind]} <span style={{ color: C.neg }}>({fs.length})</span>
              </span>
              <span style={{ font: `400 12.5px ${FONT}`, color: C.muted, flex: 1 }}>{help}</span>
              {canEdit && fs.length > 1 && kind !== 'invoice' && (
                <Pill
                  small
                  onClick={() =>
                    ack(
                      fs.map((f) => f.id),
                      `${fs.length} riasztás rendben`,
                    )
                  }
                >
                  Mind rendben
                </Pill>
              )}
            </div>
            {fs.map((f) => {
              const plan = f.kind === 'deviation' ? byId.get(byId.get(f.entry_id)?.link_id || '') : undefined;
              const fut = f.kind === 'deviation' ? futurePlans(data.entries, plan, f.date) : [];
              const cat = ix.leafById[f.leaf_id]?.label || '';
              const bad = f.kind === 'overdue' || (f.diff ?? 0) < 0 || (f.kind === 'unplanned' && f.amount < 0);
              return (
                <div
                  key={f.id}
                  style={{
                    ...card,
                    borderLeft: `4px solid ${bad ? C.neg : C.blue2}`,
                    padding: '12px 16px',
                    display: 'flex',
                    gap: 12,
                    alignItems: 'center',
                    flexWrap: 'wrap',
                  }}
                >
                  <div style={{ flex: '1 1 260px', minWidth: 0, display: 'flex', flexDirection: 'column', gap: 3 }}>
                    <span style={{ font: `600 14px ${FONT}`, color: C.ink }}>{f.name || cat}</span>
                    <span style={{ font: `400 12.5px ${FONT}`, color: C.muted }}>
                      {f.kind === 'target' ? (
                        'havi eredmény-cél (Beállítások → Statisztikák)'
                      ) : f.nav ? (
                        <>
                          <a
                            href="#"
                            title="A számla megnyitása (NAV Online Számla)"
                            onClick={(ev) => {
                              ev.preventDefault();
                              setInvoice(f.nav!.invoice_number);
                            }}
                            style={{ color: C.blueDark, fontWeight: 700, textDecoration: 'underline' }}
                          >
                            {f.nav.invoice_number} ↗
                          </a>
                          {` · kelt ${dot(f.nav.issue_date || f.date)} · fizetendő ${dot(f.date)}`}
                        </>
                      ) : (
                        <>
                          {dot(f.date)} ·{' '}
                          {f.leaf_id ? (
                            <PartnerLink leaf={f.leaf_id} style={{ color: C.blueDark, fontWeight: 600 }}>
                              {cat}
                            </PartnerLink>
                          ) : (
                            cat
                          )}
                        </>
                      )}
                      {f.tx ? ` · ${f.tx.partner || f.tx.memo}` : ''}
                    </span>
                  </div>
                  <div style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums', display: 'flex', flexDirection: 'column', gap: 2 }}>
                    {f.kind === 'target' && (
                      <>
                        <span style={{ font: `700 15px ${FONT}`, color: C.neg }}>{ft(f.diff || 0)}</span>
                        <span style={{ font: `400 12px ${FONT}`, color: C.muted }}>
                          cél {fmt(f.plan || 0)} → {fmt(f.amount)}
                        </span>
                      </>
                    )}
                    {f.kind === 'uninvoiced' && (
                      <>
                        <span style={{ font: `700 15px ${FONT}`, color: C.neg }}>{fmt(f.amount)} Ft</span>
                        <span style={{ font: `400 12px ${FONT}`, color: C.muted }}>számlázatlan terv</span>
                      </>
                    )}
                    {f.kind === 'underbilled' && (
                      <>
                        <span style={{ font: `700 15px ${FONT}`, color: C.neg }}>{ft(f.diff || 0)}</span>
                        <span style={{ font: `400 12px ${FONT}`, color: C.muted }}>
                          terv {fmt(f.plan || 0)} → számla {fmt(f.amount)}
                        </span>
                      </>
                    )}
                    {f.kind === 'deviation' && (
                      <>
                        <span style={{ font: `700 15px ${FONT}`, color: bad ? C.neg : C.blueDark }}>{ft(f.diff || 0)}</span>
                        <span style={{ font: `400 12px ${FONT}`, color: C.muted }}>
                          terv {fmt(Math.abs(f.plan || 0))} → tény {fmt(Math.abs(f.amount))}
                        </span>
                      </>
                    )}
                    {f.kind === 'invoice' && <span style={{ font: `700 15px ${FONT}`, color: C.neg }}>{ft(f.amount)}</span>}
                    {f.kind === 'unplanned' && <span style={{ font: `700 15px ${FONT}`, color: f.amount < 0 ? C.neg : C.blueDark }}>{ft(f.amount)}</span>}
                    {f.kind === 'overdue' && (
                      <>
                        <span style={{ font: `700 15px ${FONT}`, color: C.neg }}>{ft(f.amount)}</span>
                        <span style={{ font: `400 12px ${FONT}`, color: C.muted }}>{f.section === 'in' ? 'nem érkezett be' : 'nem ment ki'}</span>
                      </>
                    )}
                  </div>
                  {canEdit && (f.kind === 'unplanned' || f.kind === 'invoice') && <UnplannedActions f={f} unforeseen={unforeseen} ack={ack} />}
                  {canEdit && f.kind !== 'unplanned' && f.kind !== 'invoice' && (
                    <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                      {f.kind === 'deviation' && fut.length > 0 && (
                        <Pill
                          small
                          kind="light"
                          title={`${fut.length} nyitott jövőbeli terv összege legyen ${fmt(Math.abs(f.amount))} Ft`}
                          onClick={async () => {
                            await commit(
                              { upsert: fut.map((e) => ({ ...e, amount: f.amount })) },
                              `${fut.length} jövőbeli terv → ${fmt(Math.abs(f.amount))} Ft`,
                            );
                            await ack([f.id], 'Riasztás rendben');
                          }}
                        >
                          Jövőbeli tervek is {fmt(Math.abs(f.amount))} ({fut.length})
                        </Pill>
                      )}
                      {(f.kind === 'overdue' || f.kind === 'uninvoiced') && (
                        <Pill
                          small
                          kind="danger"
                          onClick={async () => {
                            const e = byId.get(f.entry_id);
                            if (e) await commit({ delete: [e.id] }, `Terv törölve: ${e.name || cat}`);
                          }}
                        >
                          Nem lesz – terv törlése
                        </Pill>
                      )}
                      <Pill small onClick={() => ack([f.id], 'Riasztás rendben')}>
                        {f.kind === 'overdue' ? 'Még várjuk' : 'Rendben'}
                      </Pill>
                    </div>
                  )}
                </div>
              );
            })}
          </section>
        );
      })}
      {tab === 'nav' && !navCount && (
        <div style={{ ...card, padding: '22px 20px', font: `600 14px ${FONT}`, color: C.muted }}>Még nincs besorolt NAV-számla.</div>
      )}
      {tab === 'nav' && plannedNav.length > 0 && (
        <section style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <button
            onClick={() => setShowPlanned(!showPlanned)}
            style={{ border: 0, background: 'transparent', padding: 0, textAlign: 'left', cursor: 'pointer', font: `700 16px ${FONT_H}`, color: C.navy }}
          >
            {showPlanned ? '▾' : '▸'} Kategóriába sorolt NAV-számlák <span style={{ color: C.muted }}>({plannedNav.length})</span>
          </button>
          {showPlanned && plannedNav.map((n) => <PlannedNavRow key={n.id} n={n} plan={n.plan_id ? byId.get(n.plan_id) : undefined} onInvoice={setInvoice} />)}
        </section>
      )}
      {tab === 'nav' && ignoredNav.length > 0 && (
        <section style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <button
            onClick={() => setShowIgnored(!showIgnored)}
            style={{ border: 0, background: 'transparent', padding: 0, textAlign: 'left', cursor: 'pointer', font: `700 16px ${FONT_H}`, color: C.navy }}
          >
            {showIgnored ? '▾' : '▸'} „Nem kell terv” jelölt NAV-számlák <span style={{ color: C.muted }}>({ignoredNav.length})</span>
          </button>
          {showIgnored &&
            ignoredNav.map((n) => (
              <div key={n.id} style={{ ...card, padding: '10px 14px', display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
                <span style={{ flex: '1 1 260px', minWidth: 0, display: 'flex', flexDirection: 'column', gap: 2 }}>
                  <span style={{ font: `600 13.5px ${FONT}`, color: C.ink }}>{n.partner_name}</span>
                  <span style={{ font: `400 12.5px ${FONT}`, color: C.muted }}>
                    <a
                      href="#"
                      onClick={(ev) => {
                        ev.preventDefault();
                        setInvoice(n.invoice_number);
                      }}
                      style={{ color: C.blueDark, fontWeight: 700, textDecoration: 'underline' }}
                    >
                      {n.invoice_number} ↗
                    </a>
                    {` · kelt ${dot(n.issue_date || '')}`}
                  </span>
                </span>
                <b style={{ font: `700 14px ${FONT}`, color: C.neg, fontVariantNumeric: 'tabular-nums' }}>{fmt(n.gross)} Ft</b>
                {canEdit && (
                  <Pill
                    small
                    onClick={() =>
                      run(() => api('/api/nav/resolve', { body: { id: n.id, action: 'reopen' } }), `${n.partner_name}: visszakerült a riasztások közé`)
                    }
                  >
                    Visszanyitás
                  </Pill>
                )}
              </div>
            ))}
        </section>
      )}
    </div>
  );
}

/** Besorolt NAV-számla: hova került (kategória, hónap, egyszeri / havonta), kategória módosítása, visszanyitás. */
function PlannedNavRow({ n, plan, onInvoice }: { n: NavInvoice; plan: Entry | undefined; onInvoice: (num: string) => void }) {
  const { ix, canEdit, run } = useStore();
  const [pick, setPick] = useState(false);
  const leaf = plan?.leaf_id || n.leaf_id || '';
  const date = plan?.date || n.payment_date || n.issue_date || '';
  const where = `${ix.leafById[leaf]?.label || 'ismeretlen kategória'} · ${date ? monthLong(ymOf(date)) : ''}${plan?.series_id ? ' · havonta' : ''}`;
  return (
    <div style={{ ...card, padding: '10px 14px', display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
        <span style={{ flex: '1 1 260px', minWidth: 0, display: 'flex', flexDirection: 'column', gap: 2 }}>
          <span style={{ font: `600 13.5px ${FONT}`, color: C.ink }}>{n.partner_name}</span>
          <span style={{ font: `400 12.5px ${FONT}`, color: C.muted }}>
            <a
              href="#"
              onClick={(ev) => {
                ev.preventDefault();
                onInvoice(n.invoice_number);
              }}
              style={{ color: C.blueDark, fontWeight: 700, textDecoration: 'underline' }}
            >
              {n.invoice_number} ↗
            </a>
            {` · kelt ${dot(n.issue_date || '')}`}
          </span>
          <span style={{ font: `600 12.5px ${FONT}`, color: C.blueDark }}>→ {where}</span>
        </span>
        <b style={{ font: `700 14px ${FONT}`, color: C.neg, fontVariantNumeric: 'tabular-nums' }}>{fmt(n.gross)} Ft</b>
        {canEdit && (
          <>
            <Pill small onClick={() => setPick(!pick)}>
              {pick ? 'Mégse' : 'Kategória módosítása'}
            </Pill>
            {n.status === 'planned' && (
              <Pill
                small
                onClick={() =>
                  run(() => api('/api/nav/resolve', { body: { id: n.id, action: 'reopen' } }), `${n.partner_name}: visszakerült a riasztások közé`)
                }
              >
                Visszanyitás
              </Pill>
            )}
          </>
        )}
      </div>
      {pick && (
        <LeafPicker
          section={n.gross >= 0 ? 'in' : 'out'}
          value={leaf || null}
          onChange={(id) => {
            setPick(false);
            if (id && id !== leaf)
              run(
                () => api('/api/nav/resolve', { body: { id: n.id, action: 'move', leaf_id: id } }),
                `${n.partner_name}: ${ix.leafById[id]?.label}`,
                leaf ? () => api('/api/nav/resolve', { body: { id: n.id, action: 'move', leaf_id: leaf } }) : undefined,
              );
          }}
        />
      )}
    </div>
  );
}

/** Terv nélküli tétel: javaslat (rendszeres → havonta tervbe, vagy előre nem látható költség) és a két gomb. */
function UnplannedActions({ f, unforeseen, ack }: { f: Flag; unforeseen: string | null; ack: (ids: string[], msg: string) => Promise<unknown> }) {
  const { data, ix, commit, run } = useStore();
  const e = f.entry_id ? data.entries.find((x) => x.id === f.entry_id) : undefined;
  const hint = useMemo(
    () => unplannedHint(data.entries, { name: f.name, amount: f.amount, date: f.date, leaf_id: f.leaf_id || null, id: f.entry_id || undefined }, unforeseen),
    [data.entries, f, unforeseen],
  );
  const section = f.amount >= 0 ? 'in' : 'out';
  const [leaf, setLeaf] = useState<string | null>(hint.leaf_id);
  const [pick, setPick] = useState(false);
  // kézzel választott kategória → „Mentés” gomb (egyszeri, a számla hónapjára)
  const [chosen, setChosen] = useState(false);
  const monthly = Math.abs(hint.kind === 'recurring' && !f.nav ? hint.avg : f.amount);
  const leafLabel = leaf ? ix.leafById[leaf]?.label : '';
  const nav = f.nav;

  const recurring = async () => {
    if (!leaf) return setPick(true);
    if (nav) {
      await run(
        () => api('/api/nav/resolve', { body: { id: nav.id, action: 'recurring', leaf_id: leaf, months: 12 } }),
        `${f.name}: havonta tervbe (${leafLabel}), 12 hónap`,
        () => api('/api/nav/resolve', { body: { id: nav.id, action: 'reopen' } }),
      );
      return;
    }
    const b = genSeries({
      leaf,
      section,
      name: f.name,
      amount: monthly,
      startYm: addMonths(ymOf(f.date), 1),
      count: 12,
      rep: 'monthly',
      day: Number(f.date.slice(8)) || 1,
    });
    // a mostani tény is a választott kategóriába kerül
    if (e && e.leaf_id !== leaf) b.upsert = [...(b.upsert || []), { ...e, leaf_id: leaf }];
    await commit(b, `${f.name}: havonta tervbe (${leafLabel}) · ${fmt(monthly)} Ft, 12 hónap`);
    await ack([f.id], 'Riasztás rendben');
  };
  const oneoff = async () => {
    if (nav) {
      await run(
        () => api('/api/nav/resolve', { body: { id: nav.id, action: 'unforeseen' } }),
        `${f.name}: előre nem látható költség`,
        () => api('/api/nav/resolve', { body: { id: nav.id, action: 'reopen' } }),
      );
      return;
    }
    if (section === 'out' && unforeseen && e && e.leaf_id !== unforeseen)
      await commit({ upsert: [{ ...e, leaf_id: unforeseen }] }, `${f.name}: előre nem látható költség`);
    await ack([f.id], section === 'out' ? 'Előre nem látható költség – rendben' : 'Egyszeri bevétel – rendben');
  };

  const assign = async () => {
    if (!leaf) return setPick(true);
    const label = `${f.name}: ${leafLabel} · ${monthLong(ymOf(f.date))} · ${fmt(Math.abs(f.amount))} Ft`;
    if (nav) {
      await run(
        () => api('/api/nav/resolve', { body: { id: nav.id, action: 'assign', leaf_id: leaf } }),
        label,
        () => api('/api/nav/resolve', { body: { id: nav.id, action: 'reopen' } }),
      );
      return;
    }
    if (e && e.leaf_id !== leaf) await commit({ upsert: [{ ...e, leaf_id: leaf }] }, label);
    await ack([f.id], label);
  };

  const rec = hint.kind === 'recurring';
  const text = rec
    ? `Az elmúlt 12 hónapból ${hint.months} hónapban volt ilyen (átlag ${fmt(Math.abs(hint.avg))} Ft/hó) → javaslat: vedd fel havonta a tervbe${leafLabel ? ` (${leafLabel})` : ''}.`
    : hint.months
      ? `Az elmúlt évben csak ${hint.months} hónapban fordult elő → javaslat: ${section === 'out' ? 'előre nem látható költség' : 'egyszeri bevétel'}.`
      : `Először fordul elő → javaslat: ${section === 'out' ? 'előre nem látható költség' : 'egyszeri bevétel'}.`;
  return (
    <div style={{ flex: '1 1 100%', display: 'flex', flexDirection: 'column', gap: 8 }}>
      <span style={{ font: `500 12.5px/1.45 ${FONT}`, color: C.ink, background: C.bg2, borderRadius: 10, padding: '8px 10px' }}>💡 {text}</span>
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
        {chosen && leaf && (
          <Pill small kind="primary" onClick={assign}>
            ✓ Mentés: {leafLabel} · {monthLong(ymOf(f.date))}
          </Pill>
        )}
        <Pill small kind={rec && !chosen ? 'primary' : 'light'} onClick={recurring}>
          Havonta tervbe{leafLabel ? `: ${leafLabel}` : '…'}
        </Pill>
        <Pill small kind={rec || chosen ? 'light' : 'primary'} onClick={oneoff}>
          {section === 'out' ? 'Előre nem látható költség' : 'Egyszeri – rendben'}
        </Pill>
        <Pill small onClick={() => setPick(!pick)}>
          {pick ? 'Kész' : 'Más kategória…'}
        </Pill>
        {nav && (
          <Pill
            small
            onClick={() =>
              run(
                () => api('/api/nav/resolve', { body: { id: nav.id, action: 'ignore' } }),
                'Számla: nem kell terv',
                () => api('/api/nav/resolve', { body: { id: nav.id, action: 'reopen' } }),
              )
            }
          >
            Nem kell terv
          </Pill>
        )}
      </div>
      {pick && (
        <LeafPicker
          section={section}
          value={leaf}
          onChange={(id) => {
            setLeaf(id);
            setChosen(true);
            setPick(false);
          }}
        />
      )}
    </div>
  );
}

export function FlagBanner({ n, kinds, onClick, mobile }: { n: number; kinds: string[]; onClick: () => void; mobile?: boolean }) {
  const cnt = (k: string) => kinds.filter((x) => x === k).length;
  const parts = [
    cnt('uninvoiced') && `${cnt('uninvoiced')} nincs kiszámlázva`,
    cnt('underbilled') && `${cnt('underbilled')} alacsonyabb számla`,
    cnt('invoice') && `${cnt('invoice')} új számla terv nélkül`,
    cnt('deviation') && `${cnt('deviation')} eltérés a tervtől`,
    cnt('unplanned') && `${cnt('unplanned')} nem tervezett tétel`,
    cnt('overdue') && `${cnt('overdue')} elmaradt terv`,
    cnt('target') && 'eredmény a cél alatt',
  ].filter(Boolean);
  return (
    <button
      onClick={onClick}
      style={{
        margin: mobile ? '14px 16px 0' : 0,
        width: mobile ? 'calc(100% - 32px)' : '100%',
        border: `1px solid ${C.negLight}`,
        background: C.negBg,
        borderRadius: 14,
        padding: '13px 16px',
        display: 'flex',
        alignItems: 'center',
        gap: 12,
        textAlign: 'left',
        cursor: 'pointer',
      }}
    >
      <span
        style={{
          minWidth: 30,
          height: 30,
          borderRadius: 999,
          background: C.neg,
          color: '#fff',
          display: 'grid',
          placeItems: 'center',
          font: `700 13px ${FONT}`,
        }}
      >
        {n}
      </span>
      <span style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 2 }}>
        <b style={{ font: `700 14px ${FONT}`, color: C.neg }}>Riasztás: eltérés a havi tervtől</b>
        <span style={{ font: `500 12.5px ${FONT}`, color: C.ink }}>{parts.join(' · ')}</span>
      </span>
      <span style={{ font: `600 13px ${FONT}`, color: C.neg }}>Megnézem →</span>
    </button>
  );
}

interface NavInvoiceData {
  number: string;
  supplier: string;
  supplierTax: string;
  supplierAddress: string;
  customer: string;
  issueDate: string;
  deliveryDate: string;
  paymentDate: string;
  paymentMethod: string;
  currency: string;
  lines: { desc: string; qty: number | null; unit: string; unitPrice: number | null; net: number; vat: string; gross: number }[];
  net: number;
  vat: number;
  gross: number;
}

const PAY_METHOD: Record<string, string> = { TRANSFER: 'átutalás', CASH: 'készpénz', CARD: 'bankkártya', VOUCHER: 'utalvány', OTHER: 'egyéb' };
const UNIT: Record<string, string> = { PIECE: 'db', HOUR: 'óra', DAY: 'nap', MONTH: 'hó', KILOGRAM: 'kg', LITER: 'l', KWH: 'kWh', KILOMETER: 'km' };

/** Bejövő számla a NAV Online Számlából: fejadatok, tételsorok, összesítő. */
export function NavInvoiceModal({ number, onClose }: { number: string; onClose: () => void }) {
  const { data } = useStore();
  const [inv, setInv] = useState<NavInvoiceData | null>(null);
  const [err, setErr] = useState('');
  const local = (data.navInvoices || []).find((n) => n.invoice_number === number);
  useEffect(() => {
    let off = false;
    api<NavInvoiceData>(`/api/nav/invoice?n=${encodeURIComponent(number)}`)
      .then((r) => !off && setInv(r))
      .catch((e) => !off && setErr(e.message || 'Nem sikerült lekérni a számlát.'));
    return () => {
      off = true;
    };
  }, [number]);
  const dt = (d?: string | null) => (d ? d.replace(/-/g, '.') + '.' : '–');
  return (
    <Modal onClose={onClose} width={820}>
      <div style={{ padding: '20px 24px', display: 'flex', flexDirection: 'column', gap: 12 }}>
        <span style={{ font: `600 12px ${FONT}`, letterSpacing: '.14em', textTransform: 'uppercase', color: C.muted }}>Bejövő számla · NAV Online Számla</span>
        <b style={{ font: `800 22px ${FONT_H}`, color: C.navy }}>{inv?.supplier || local?.partner_name || number}</b>
        <span style={{ font: `500 13px ${FONT}`, color: C.muted }}>
          {number}
          {inv?.supplierTax || local?.partner_tax ? ` · adószám ${inv?.supplierTax || local?.partner_tax}` : ''}
          {inv?.supplierAddress ? ` · ${inv.supplierAddress}` : ''}
        </span>
        {!inv && !err && <span style={{ color: C.muted, font: `500 13px ${FONT}` }}>Számla lekérése a NAV-tól…</span>}
        {err && (
          <span style={{ color: C.neg, font: `500 13px ${FONT}` }}>
            {err}
            {local ? ` · a tárolt adatok: kelt ${dt(local.issue_date)}, fizetendő ${dt(local.payment_date)}, ${fmt(Math.abs(local.gross))} Ft` : ''}
          </span>
        )}
        {inv && (
          <>
            <div style={{ display: 'flex', gap: 18, flexWrap: 'wrap', font: `500 13px ${FONT}`, color: C.ink }}>
              <span>
                Kelt: <b>{dt(inv.issueDate)}</b>
              </span>
              <span>
                Teljesítés: <b>{dt(inv.deliveryDate)}</b>
              </span>
              <span>
                Fizetési határidő: <b>{dt(inv.paymentDate)}</b>
              </span>
              <span>
                Fizetés: <b>{PAY_METHOD[inv.paymentMethod] || inv.paymentMethod || '–'}</b>
              </span>
              {inv.customer && (
                <span>
                  Vevő: <b>{inv.customer}</b>
                </span>
              )}
            </div>
            {/* tételsorok: keskeny kijelzőn is olvasható (név, alatta mennyiség × egységár · nettó · ÁFA, jobbra a bruttó) */}
            <div style={{ border: `1px solid ${C.line}`, borderRadius: 12, overflow: 'hidden' }}>
              {inv.lines.map((l, i) => (
                <div
                  key={i}
                  style={{ display: 'flex', gap: 12, alignItems: 'baseline', padding: '9px 12px', borderTop: i ? `1px solid ${C.line3}` : 0, flexWrap: 'wrap' }}
                >
                  <span style={{ flex: '1 1 220px', minWidth: 0, display: 'flex', flexDirection: 'column', gap: 2 }}>
                    <span style={{ font: `600 13.5px ${FONT}`, color: C.navy, wordBreak: 'break-word' }}>{l.desc}</span>
                    <span style={{ font: `500 12px ${FONT}`, color: C.muted, fontVariantNumeric: 'tabular-nums' }}>
                      {[
                        l.qty != null ? `${l.qty} ${UNIT[l.unit] || l.unit.toLowerCase()}` + (l.unitPrice != null ? ` × ${fmt(l.unitPrice)}` : '') : '',
                        l.net ? `nettó ${fmt(l.net)}` : '',
                        l.vat ? `ÁFA ${l.vat}` : '',
                      ]
                        .filter(Boolean)
                        .join(' · ')}
                    </span>
                  </span>
                  <b style={{ font: `700 14px ${FONT}`, color: C.navy, fontVariantNumeric: 'tabular-nums', marginLeft: 'auto' }}>{fmt(l.gross)} Ft</b>
                </div>
              ))}
            </div>
            <div style={{ display: 'flex', gap: 14, justifyContent: 'flex-end', flexWrap: 'wrap', font: `600 14px ${FONT}`, color: C.navy }}>
              <span>Nettó {fmt(inv.net)} Ft</span>
              <span>ÁFA {fmt(inv.vat)} Ft</span>
              <span style={{ font: `800 16px ${FONT_H}` }}>Bruttó {fmt(inv.gross)} Ft</span>
              {inv.currency !== 'HUF' && <span style={{ color: C.muted }}>(eredeti pénznem: {inv.currency})</span>}
            </div>
          </>
        )}
        <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
          <Pill onClick={onClose}>Bezárás</Pill>
        </div>
      </div>
    </Modal>
  );
}
