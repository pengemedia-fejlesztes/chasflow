// Bankszinkron: számlák egyenlege, beérkezett banki tételek jóváhagyása (kategória + terv párosítás).
import { fmt, monthLabel, ymOf } from '../../shared/model';
import type { BankTx, Entry } from '../../shared/types';
import { api } from './api';
import { useStore } from './store';
import { C, FONT, FONT_H, LeafSelect, Pill, card, eyebrow, inputStyle, relTime, shortDate } from './ui';

function candidates(tx: BankTx, entries: Entry[]): Entry[] {
  return entries
    .filter((e) => e.kind === 'plan' && !e.done && Math.sign(e.amount) === Math.sign(tx.amount))
    .map((e) => ({ e, dd: Math.abs(Date.parse(tx.date) - Date.parse(e.date)) / 86400000, da: Math.abs(Math.abs(e.amount) - Math.abs(tx.amount)) }))
    .filter((x) => x.dd <= 75)
    .sort((a, b) =>
      tx.leaf_id && (a.e.leaf_id === tx.leaf_id) !== (b.e.leaf_id === tx.leaf_id) ? (a.e.leaf_id === tx.leaf_id ? -1 : 1) : a.da - b.da || a.dd - b.dd,
    )
    .slice(0, 25)
    .map((x) => x.e);
}

export function BankView({ mobile }: { mobile?: boolean }) {
  const { ix, data, run, canEdit } = useStore();
  const inbox = data.bankTx.filter((t) => t.status === 'new').sort((a, b) => b.date.localeCompare(a.date));
  const done = data.bankTx.filter((t) => t.status !== 'new').slice(0, 30);
  const byId = new Map(data.entries.map((e) => [e.id, e]));
  const accounts = data.accounts.filter((a) => a.active);
  const lastSync = Math.max(0, ...accounts.map((a) => a.last_sync || 0));

  const patch = (id: string, body: object) => run(() => api(`/api/bank/tx/${id}`, { method: 'PATCH', body }));
  const approve = (ids: string[]) =>
    run(
      () => api('/api/bank/approve', { body: { ids } }),
      `${ids.length} banki tétel jóváhagyva, terv lezárva`,
      () => api('/api/bank/unapprove', { body: { ids } }),
    );
  const ignore = (ids: string[]) =>
    run(
      () => api('/api/bank/ignore', { body: { ids } }),
      `${ids.length} tétel kihagyva`,
      () => api('/api/bank/ignore', { body: { ids, undo: true } }),
    );
  const ready = inbox.filter((t) => t.leaf_id);

  return (
    <div style={{ padding: mobile ? '14px 16px 120px' : '28px 32px 120px', display: 'flex', flexDirection: 'column', gap: 16, maxWidth: 1180 }}>
      {!mobile && (
        <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', gap: 16, flexWrap: 'wrap' }}>
          <div>
            <div style={{ font: `600 12px ${FONT}`, letterSpacing: '.18em', textTransform: 'uppercase', color: C.blue, marginBottom: 8 }}>Bankszinkron</div>
            <h1 style={{ margin: 0, font: `700 30px/1.05 ${FONT_H}`, color: C.navy }}>Beérkezett banki tételek</h1>
            <p style={{ margin: '10px 0 0', font: `400 15px/1.5 ${FONT}`, color: C.muted, maxWidth: '62ch' }}>
              A rendszer kategóriát javasol és párosítja a tervezett tétellel (pl. Billingo számlával). Jóváhagyáskor a terv lezárul, az összeg tényként kerül
              be.
            </p>
          </div>
          {canEdit && (
            <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
              <Pill onClick={() => run(() => api('/api/sync', { body: {} }), 'Szinkron kész')}>↻ Szinkronizálás most</Pill>
              {ready.length > 0 && (
                <Pill kind="primary" onClick={() => approve(ready.map((t) => t.id))}>
                  Mind jóváhagyása ({ready.length})
                </Pill>
              )}
            </div>
          )}
        </div>
      )}
      {mobile && canEdit && (
        <div style={{ display: 'flex', gap: 8 }}>
          <Pill style={{ flex: 1 }} onClick={() => run(() => api('/api/sync', { body: {} }), 'Szinkron kész')}>
            ↻ Frissítés
          </Pill>
        </div>
      )}

      <div
        style={{
          background: C.navy2,
          borderRadius: 14,
          padding: '16px 20px',
          display: 'flex',
          gap: mobile ? 14 : 28,
          flexWrap: 'wrap',
          alignItems: 'center',
          color: '#fff',
        }}
      >
        {accounts.length === 0 && (
          <span style={{ font: `500 14px ${FONT}`, color: C.muted2 }}>
            Nincs bekötött bankszámla. Beállítások › Bankkapcsolat (BiNX, Magnet – PSD2), vagy kivonat (CSV) import.
          </span>
        )}
        {accounts.map((a) => (
          <div key={a.id} style={{ display: 'flex', alignItems: 'center', gap: 12, minWidth: 220 }}>
            <div
              style={{
                width: 40,
                height: 40,
                borderRadius: 11,
                background: C.navy3,
                display: 'grid',
                placeItems: 'center',
                font: `800 11px ${FONT_H}`,
                color: C.blue2,
                textTransform: 'uppercase',
              }}
            >
              {a.bank_name.slice(0, 4)}
            </div>
            <div style={{ display: 'flex', flexDirection: 'column' }}>
              <span style={{ font: `700 14px ${FONT_H}` }}>
                {a.bank_name} · {a.label}
              </span>
              <span style={{ font: `400 12px ${FONT}`, color: C.muted2 }}>
                {a.iban ? a.iban.replace(/^(.{4}).*(.{4})$/, '$1 •••• $2') : a.provider === 'manual' ? 'kézi kivonat' : ''}
              </span>
              <span style={{ font: `800 17px ${FONT_H}`, fontVariantNumeric: 'tabular-nums' }}>
                {a.balance != null ? fmt(a.balance) + ' ' + (a.currency === 'HUF' ? 'Ft' : a.currency) : '—'}
              </span>
              <span style={{ font: `500 11.5px ${FONT}`, color: a.last_error ? C.negLight : C.muted2 }}>
                {a.last_error ? a.last_error : `szinkron: ${relTime(a.last_sync)}${a.valid_until ? ' · hozzájárulás: ' + a.valid_until.slice(0, 10) : ''}`}
              </span>
            </div>
          </div>
        ))}
        {accounts.length > 0 && (
          <div style={{ display: 'flex', flexDirection: 'column', marginLeft: 'auto' }}>
            <span style={{ ...eyebrow, color: C.muted2 }}>Összesen · {relTime(lastSync)}</span>
            <span style={{ font: `800 20px ${FONT_H}`, fontVariantNumeric: 'tabular-nums' }}>{ix.bankBalance != null ? fmt(ix.bankBalance) + ' Ft' : '—'}</span>
            <span style={{ font: `500 12px ${FONT}`, color: C.muted2 }}>automatikusan óránként</span>
          </div>
        )}
      </div>

      {inbox.length === 0 && (
        <div style={{ ...card, padding: 36, textAlign: 'center', display: 'flex', flexDirection: 'column', gap: 6 }}>
          <span style={{ font: `700 18px ${FONT_H}`, color: C.navy }}>Minden tétel rendezve</span>
          <span style={{ font: `400 14px ${FONT}`, color: C.muted }}>Az új banki mozgások szinkronizálás után itt jelennek meg.</span>
        </div>
      )}

      {inbox.map((t) => {
        const cands = candidates(t, data.entries);
        const plan = t.plan_id ? byId.get(t.plan_id) : null;
        const diff = plan ? Math.abs(t.amount) - Math.abs(plan.amount) : 0;
        const dup = data.entries.find((e) => e.kind === 'actual' && e.amount === t.amount && Math.abs(Date.parse(e.date) - Date.parse(t.date)) <= 5 * 86400000);
        const acc = data.accounts.find((a) => a.id === t.account_id);
        const section = t.amount >= 0 ? 'in' : 'out';
        return (
          <div
            key={t.id}
            style={{
              ...card,
              padding: '14px 16px',
              display: 'grid',
              gridTemplateColumns: mobile ? '1fr' : 'minmax(0,1.3fr) 130px minmax(0,1.4fr) auto',
              gap: '10px 16px',
              alignItems: 'center',
            }}
          >
            <div style={{ display: 'flex', flexDirection: 'column', minWidth: 0, gap: 2 }}>
              <span style={{ font: `600 14.5px ${FONT}`, color: C.navy }}>{t.partner || '(ismeretlen partner)'}</span>
              <span style={{ font: `400 12.5px ${FONT}`, color: C.muted, overflow: 'hidden', textOverflow: 'ellipsis' }}>
                {shortDate(t.date)} · {acc?.bank_name} · {t.memo}
              </span>
            </div>
            <span
              style={{
                textAlign: mobile ? 'left' : 'right',
                font: `700 16px ${FONT_H}`,
                color: t.amount > 0 ? C.blueDark : C.navy,
                fontVariantNumeric: 'tabular-nums',
              }}
            >
              {t.amount > 0 ? '+' : '−'}
              {fmt(Math.abs(t.amount))}
            </span>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6, minWidth: 0 }}>
              <LeafSelect
                ix={ix}
                section={section}
                value={t.leaf_id}
                onChange={(v) => patch(t.id, { leaf_id: v })}
                style={{ height: 34, background: C.bg2, color: C.blueDark, fontSize: 13 }}
              />
              <select
                value={t.plan_id || ''}
                onChange={(e) => patch(t.id, { plan_id: e.target.value || null })}
                style={{ ...inputStyle, height: 32, fontSize: 12.5, color: plan ? C.blueDark : C.muted }}
              >
                <option value="">Nincs tervezett pár — új tény tétel lesz</option>
                {cands.map((e) => (
                  <option key={e.id} value={e.id}>
                    {`Terv: ${e.name || ix.leafById[e.leaf_id]?.label} · ${monthLabel(ymOf(e.date))} ${Number(e.date.slice(8))}. · ${fmt(Math.abs(e.amount))}`}
                  </option>
                ))}
              </select>
              {plan && diff !== 0 && (
                <span style={{ font: `500 12px ${FONT}`, color: '#8A6D1C' }}>
                  Eltérés a tervtől: {diff > 0 ? '+' : '−'}
                  {fmt(Math.abs(diff))} Ft
                </span>
              )}
              {dup && (
                <span style={{ font: `500 12px ${FONT}`, color: C.neg }}>
                  Lehetséges duplikáció: már van ilyen tény ({dup.date}, {dup.name}) – ha az, hagyd ki.
                </span>
              )}
            </div>
            {canEdit && (
              <div style={{ display: 'flex', gap: 8, justifyContent: mobile ? 'stretch' : 'flex-end' }}>
                <Pill small onClick={() => ignore([t.id])} style={mobile ? { flex: 1, height: 42 } : undefined}>
                  Kihagy
                </Pill>
                <Pill small kind="dark" disabled={!t.leaf_id} onClick={() => approve([t.id])} style={mobile ? { flex: 2, height: 42 } : undefined}>
                  Jóváhagy ✓
                </Pill>
              </div>
            )}
          </div>
        );
      })}
      {mobile && canEdit && ready.length > 1 && (
        <Pill kind="primary" onClick={() => approve(ready.map((t) => t.id))} style={{ height: 50 }}>
          Mind jóváhagyása ({ready.length})
        </Pill>
      )}

      {done.length > 0 && (
        <details style={{ ...card, padding: '12px 16px' }}>
          <summary style={{ cursor: 'pointer', font: `600 14px ${FONT}`, color: C.navy }}>Korábban feldolgozott banki tételek ({done.length})</summary>
          {done.map((t) => (
            <div key={t.id} style={{ display: 'flex', gap: 10, alignItems: 'center', padding: '8px 0', borderTop: `1px solid ${C.line3}`, flexWrap: 'wrap' }}>
              <span style={{ font: `500 12.5px ${FONT}`, color: C.muted, width: 52 }}>{shortDate(t.date)}</span>
              <span style={{ flex: 1, minWidth: 140, font: `500 13px ${FONT}`, color: C.ink }}>{t.partner || t.memo}</span>
              <span style={{ font: `600 13px ${FONT}`, color: C.navy, fontVariantNumeric: 'tabular-nums' }}>{fmt(t.amount)}</span>
              <span style={{ font: `500 12px ${FONT}`, color: t.status === 'approved' ? C.blueDark : C.muted, width: 80 }}>
                {t.status === 'approved' ? 'jóváhagyva' : 'kihagyva'}
              </span>
              {canEdit && (
                <button
                  onClick={() =>
                    t.status === 'approved'
                      ? run(() => api('/api/bank/unapprove', { body: { ids: [t.id] } }), 'Visszaállítva')
                      : run(() => api('/api/bank/ignore', { body: { ids: [t.id], undo: true } }), 'Visszaállítva')
                  }
                  style={{ border: 0, background: 'transparent', color: C.blueDark, font: `600 12.5px ${FONT}`, cursor: 'pointer' }}
                >
                  Visszavonás
                </button>
              )}
            </div>
          ))}
        </details>
      )}
    </div>
  );
}
