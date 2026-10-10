// Bankszinkron: számlák egyenlege, beérkezett banki tételek jóváhagyása (kategória + terv párosítás).
import { useMemo } from 'react';
import { normalizeText } from '../../shared/categories';
import { fmt } from '../../shared/model';
import { api } from './api';
import { useStore } from './store';
import { TxCard } from './TxCard';
import { C, FONT, FONT_H, Pill, card, eyebrow, relTime, shortDate, SyncPill } from './ui';

export function BankView({ mobile }: { mobile?: boolean }) {
  const { ix, data, run, canEdit } = useStore();
  const inbox = data.bankTx.filter((t) => t.status === 'new').sort((a, b) => b.date.localeCompare(a.date));
  const done = data.bankTx.filter((t) => t.status !== 'new').slice(0, 30);
  const accounts = data.accounts.filter((a) => a.active);
  const lastSync = Math.max(0, ...accounts.map((a) => a.last_sync || 0));

  const approve = (ids: string[]) =>
    run(
      () => api('/api/bank/approve', { body: { ids } }),
      `${ids.length} banki tétel jóváhagyva, terv lezárva`,
      () => api('/api/bank/unapprove', { body: { ids } }),
    );
  // az új kiadások alapértelmezett kategóriája: „Előre nem látható költség”
  const unforeseen = ix.leaves.find((l) => !l.archived && ix.sectionOf(l.id) === 'out' && normalizeText(l.label).startsWith('elore nem lathato'))?.id ?? null;
  const ready = inbox.filter((t) => t.leaf_id || (t.amount < 0 && unforeseen));
  // leggyakoribb kategóriák az elmúlt évből (gyors választáshoz)
  const [freqIn, freqOut] = useMemo(() => {
    const since = String(Number(data.today.slice(0, 4)) - 1) + data.today.slice(4);
    const cnt: Record<string, number> = {};
    data.entries.forEach((e) => e.kind === 'actual' && e.date >= since && (cnt[e.leaf_id] = (cnt[e.leaf_id] || 0) + 1));
    const top = (sec: 'in' | 'out') =>
      Object.keys(cnt)
        .filter((id) => ix.leafById[id] && !ix.leafById[id].archived && ix.sectionOf(id) === sec)
        .sort((a, b) => cnt[b] - cnt[a])
        .slice(0, 6);
    return [top('in'), top('out')];
  }, [data.entries, data.today, ix]);

  return (
    <div style={{ padding: mobile ? '14px 16px 120px' : '28px 32px 120px', display: 'flex', flexDirection: 'column', gap: 16, maxWidth: 1180 }}>
      {!mobile && (
        <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', gap: 16, flexWrap: 'wrap' }}>
          <div>
            <div style={{ font: `600 12px ${FONT}`, letterSpacing: '.18em', textTransform: 'uppercase', color: C.blue, marginBottom: 8 }}>Bankszinkron</div>
            <h1 style={{ margin: 0, font: `700 30px/1.05 ${FONT_H}`, color: C.navy }}>Beérkezett banki tételek</h1>
            <p style={{ margin: '10px 0 0', font: `400 15px/1.5 ${FONT}`, color: C.muted, maxWidth: '62ch' }}>
              A rendszer kategóriát javasol és párosítja a tervvel (pl. Billingo számlával). A tény mindig a banki dátumra kerül; ha ismétlődő, a következő
              hónapoktól terv is készül belőle.
            </p>
          </div>
          {canEdit && (
            <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
              <SyncPill label="↻ Szinkronizálás most" onRun={() => run(() => api('/api/sync', { body: {} }), 'Szinkron kész')} />
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
          <SyncPill style={{ flex: 1 }} label="↻ Frissítés" onRun={() => run(() => api('/api/sync', { body: {} }), 'Szinkron kész')} />
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
            <span style={{ font: `500 12px ${FONT}`, color: C.muted2 }}>automatikusan: 5, 9, 13, 17, 21 órakor</span>
          </div>
        )}
      </div>

      {inbox.length === 0 && (
        <div style={{ ...card, padding: 36, textAlign: 'center', display: 'flex', flexDirection: 'column', gap: 6 }}>
          <span style={{ font: `700 18px ${FONT_H}`, color: C.navy }}>Minden tétel rendezve</span>
          <span style={{ font: `400 14px ${FONT}`, color: C.muted }}>Az új banki mozgások szinkronizálás után itt jelennek meg.</span>
        </div>
      )}

      {inbox.map((t) => (
        <TxCard key={t.id} t={t} frequent={t.amount >= 0 ? freqIn : freqOut} unforeseen={unforeseen} mobile={mobile} />
      ))}
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
