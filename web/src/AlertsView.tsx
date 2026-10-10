// Riasztások: ahol a tény eltér a havi tervtől (eltérés, nem tervezett tétel, elmaradt terv).
import { useMemo, useState } from 'react';
import { normalizeText } from '../../shared/categories';
import { billingFlags, computeFlags, flagsFrom, FLAG_LABEL, type Flag, type FlagKind } from '../../shared/flags';
import { DEFAULT_PAY_DAYS } from '../../shared/workdays';
import { addMonths, fmt, monthLong, ymOf } from '../../shared/model';
import { unplannedHint } from '../../shared/unplanned';
import { LeafPicker } from './LeafPicker';
import { genSeries } from './logic';
import { targetTracking } from '../../shared/insights';
import type { Entry } from '../../shared/types';
import { api } from './api';
import { useStore } from './store';
import { C, FONT, FONT_H, Pill, card } from './ui';

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

  const pad = mobile ? '14px 16px 24px' : '28px 32px 120px';
  return (
    <div style={{ padding: pad, display: 'flex', flexDirection: 'column', gap: 16, maxWidth: 980 }}>
      {!mobile && (
        <div>
          <div style={{ font: `600 12px ${FONT}`, letterSpacing: '.18em', textTransform: 'uppercase', color: C.neg, marginBottom: 8 }}>Riasztások</div>
          <h1 style={{ margin: 0, font: `700 30px/1.05 ${FONT_H}`, color: C.navy }}>Eltérések a tervtől</h1>
        </div>
      )}
      <span style={{ font: `400 13px/1.5 ${FONT}`, color: C.muted }}>
        Figyelt időszak: {dot(from)} – ma. Eltérésnek számít, ha a tény legalább 1 000 Ft-tal (és 1%-kal) más, mint a terv. A „Rendben” mindkettőtöknél
        eltünteti a riasztást.
      </span>
      {!flags.length && (
        <div style={{ ...card, padding: '22px 20px', font: `600 14px ${FONT}`, color: C.blueDark }}>✓ Nincs eltérés – minden tény a terv szerint alakult.</div>
      )}
      {groups.map(([kind, help]) => {
        const fs = flags.filter((f) => f.kind === kind);
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
                      {f.kind === 'target'
                        ? 'havi eredmény-cél (Beállítások → Statisztikák)'
                        : f.nav
                          ? `${f.nav.invoice_number} · kelt ${dot(f.nav.issue_date || f.date)} · fizetendő ${dot(f.date)}`
                          : `${dot(f.date)} · ${cat}`}
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
        <Pill small kind={rec ? 'primary' : 'light'} onClick={recurring}>
          Havonta tervbe{leafLabel ? `: ${leafLabel}` : '…'}
        </Pill>
        <Pill small kind={rec ? 'light' : 'primary'} onClick={oneoff}>
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
