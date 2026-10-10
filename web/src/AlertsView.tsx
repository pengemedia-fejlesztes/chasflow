// Riasztások: ahol a tény eltér a havi tervtől (eltérés, nem tervezett tétel, elmaradt terv).
import { useMemo } from 'react';
import { computeFlags, flagsFrom, FLAG_LABEL, type Flag, type FlagKind } from '../../shared/flags';
import { addMonths, fmt, monthLong } from '../../shared/model';
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
    const flags = computeFlags(data.entries, data.bankTx, ix.sectionOf, data.today, ack);
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
  }, [data.entries, data.bankTx, data.settings.flags_ack, data.settings.profit_target, data.today, ix]);
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

  const ack = (ids: string[], msg: string) =>
    run(
      () => api('/api/flags/ack', { body: { ids } }),
      msg,
      () => api('/api/flags/ack', { body: { ids, undo: true } }),
    );

  const groups: [FlagKind, string][] = [
    ['target', 'A havi eredmény (bevétel − kiadás) elmarad a beállított céltól.'],
    ['deviation', 'A tény más összeggel érkezett, mint a terv.'],
    ['unplanned', 'Nem volt rá terv – ellenőrizd, és ha ismétlődik, tervezd be.'],
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
              {canEdit && fs.length > 1 && (
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
                      {f.kind === 'target' ? 'havi eredmény-cél (Beállítások → Statisztikák)' : `${dot(f.date)} · ${cat}`}
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
                    {f.kind === 'deviation' && (
                      <>
                        <span style={{ font: `700 15px ${FONT}`, color: bad ? C.neg : C.blueDark }}>{ft(f.diff || 0)}</span>
                        <span style={{ font: `400 12px ${FONT}`, color: C.muted }}>
                          terv {fmt(Math.abs(f.plan || 0))} → tény {fmt(Math.abs(f.amount))}
                        </span>
                      </>
                    )}
                    {f.kind === 'unplanned' && <span style={{ font: `700 15px ${FONT}`, color: f.amount < 0 ? C.neg : C.blueDark }}>{ft(f.amount)}</span>}
                    {f.kind === 'overdue' && (
                      <>
                        <span style={{ font: `700 15px ${FONT}`, color: C.neg }}>{ft(f.amount)}</span>
                        <span style={{ font: `400 12px ${FONT}`, color: C.muted }}>{f.section === 'in' ? 'nem érkezett be' : 'nem ment ki'}</span>
                      </>
                    )}
                  </div>
                  {canEdit && (
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
                      {f.kind === 'overdue' && (
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

export function FlagBanner({ n, kinds, onClick, mobile }: { n: number; kinds: string[]; onClick: () => void; mobile?: boolean }) {
  const cnt = (k: string) => kinds.filter((x) => x === k).length;
  const parts = [
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
