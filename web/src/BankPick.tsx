// Asztali „Bank párosítás”: egy tervtételhez a hozzá tartozó banki tétel kiválasztása (ugyanaz a logika, mint a mobil tétel-lapon).
import { useState } from 'react';
import { fmt } from '../../shared/model';
import type { Entry } from '../../shared/types';
import { api } from './api';
import { useStore } from './store';
import { C, FONT, FONT_H, Pill, card, R } from './ui';

export function BankPickDialog({ plan, onClose }: { plan: Entry; onClose: () => void }) {
  const { data, ix, run } = useStore();
  const [q0, setQ] = useState('');
  const q = q0.trim().toLowerCase().replace(/\s+/g, '');
  const cands = data.bankTx
    .filter((t) => !t.actual_id && (t.status === 'new' || t.status === 'ignored') && Math.sign(t.amount) === Math.sign(plan.amount))
    .filter((t) => !q || `${t.partner} ${t.memo} ${Math.abs(t.amount)}`.toLowerCase().replace(/\s+/g, '').includes(q))
    .map((t) => ({
      t,
      score:
        Math.abs(Math.abs(t.amount) - Math.abs(plan.amount)) / Math.max(1, Math.abs(plan.amount)) +
        Math.abs(Date.parse(t.date) - Date.parse(plan.date)) / (30 * 86400000) +
        (t.leaf_id === plan.leaf_id ? -0.5 : 0) +
        (t.plan_id === plan.id ? -1 : 0),
    }))
    .sort((a, b) => a.score - b.score)
    .slice(0, 40);
  const link = (t: (typeof cands)[number]['t']) =>
    run(
      async () => {
        if (t.status === 'ignored') await api('/api/bank/ignore', { body: { ids: [t.id], undo: true } });
        await api('/api/bank/approve', { body: { items: [{ id: t.id, plan_id: plan.id, leaf_id: plan.leaf_id }] } });
      },
      `${plan.name || ix.leafById[plan.leaf_id]?.label}: összevonva a banki tétellel (${fmt(Math.abs(t.amount))} Ft)`,
    ).then((ok) => ok && onClose());
  return (
    <div
      onClick={onClose}
      style={{ position: 'fixed', inset: 0, zIndex: 60, background: 'rgba(0,32,64,.35)', display: 'grid', placeItems: 'center', padding: 16 }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{ ...card, width: 'min(620px,100%)', maxHeight: '86vh', display: 'flex', flexDirection: 'column', gap: 12, padding: '20px 22px' }}
      >
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12 }}>
          <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 2 }}>
            <span style={{ font: `600 11px ${FONT}`, letterSpacing: '.14em', textTransform: 'uppercase', color: C.blue }}>Bank párosítás</span>
            <span style={{ font: `700 18px ${FONT_H}`, color: C.navy }}>
              {ix.leafById[plan.leaf_id]?.label} · {plan.name}
            </span>
            <span style={{ font: `500 13px ${FONT}`, color: C.muted }}>
              terv {fmt(Math.abs(plan.amount))} Ft · {plan.date.replace(/-/g, '.')}. – válaszd ki a hozzá tartozó banki tételt
            </span>
          </div>
          <Pill small onClick={onClose}>
            Bezár
          </Pill>
        </div>
        <input
          autoFocus
          value={q0}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Keresés: partner, közlemény, összeg…"
          aria-label="Banki tétel keresése"
          style={{ height: 40, border: `1px solid ${C.line2}`, borderRadius: R.lg, padding: '0 12px', font: `500 14px ${FONT}`, color: C.ink }}
        />
        <div style={{ display: 'flex', flexDirection: 'column', border: `1px solid ${C.line}`, borderRadius: R.lg, overflowY: 'auto' }}>
          {!cands.length && <div style={{ padding: 16, font: `500 13.5px ${FONT}`, color: C.muted }}>Nincs összevonható banki tétel.</div>}
          {cands.map(({ t }, i) => {
            const same = Math.abs(t.amount) === Math.abs(plan.amount);
            return (
              <button
                key={t.id}
                className="hov-light"
                onClick={() => link(t)}
                style={{
                  border: 0,
                  borderTop: i ? `1px solid ${C.line3}` : 0,
                  background: t.plan_id === plan.id ? C.bg2 : '#fff',
                  padding: '10px 12px',
                  display: 'flex',
                  alignItems: 'center',
                  gap: 12,
                  textAlign: 'left',
                  cursor: 'pointer',
                }}
              >
                <span style={{ width: 48, flex: 'none', font: `700 13px ${FONT_H}`, color: C.navy }}>{t.date.slice(5).replace('-', '.')}.</span>
                <span style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
                  <b style={{ font: `600 13.5px ${FONT}`, color: C.navy, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {t.partner || '—'}
                  </b>
                  <span style={{ font: `400 12px ${FONT}`, color: C.muted, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{t.memo}</span>
                </span>
                <b style={{ font: `700 14px ${FONT}`, color: same ? C.blueDark : C.ink, fontVariantNumeric: 'tabular-nums' }}>
                  {t.amount < 0 ? '−' : '+'}
                  {fmt(Math.abs(t.amount))}
                </b>
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}
