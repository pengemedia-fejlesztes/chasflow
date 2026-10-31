// Bankszinkron: számlák egyenlege, beérkezett banki tételek jóváhagyása (kategória + terv párosítás).
import { useEffect, useMemo, useRef, useState } from 'react';
import { normalizeText } from '../../shared/categories';
import { fmt } from '../../shared/model';
import { api } from './api';
import { useStore } from './store';
import { BANK_COLS, BANK_MINW, TxCard } from './TxCard';
import { C, FONT, FONT_H, Pill, card, eyebrow, shortDate, stamp, SyncPill, R } from './ui';

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
  const [freqIn, freqOut] = useFrequentLeaves();
  // asztalon táblázat: egy sor van lenyitva (alapból az első); Enter = jóváhagy, K = kihagy, ↓/↑ = következő/előző
  const [openId, setOpenId] = useState<string | null>(null);
  const curOpen = openId === 'none' ? null : openId && inbox.some((t) => t.id === openId) ? openId : inbox[0]?.id || null;
  const acts = useRef<{ approve: () => void; skip: () => void } | null>(null);
  acts.current = null; // a lenyitott sor a saját renderelésekor tölti ki
  useEffect(() => {
    if (mobile || !canEdit) return;
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      if (['INPUT', 'TEXTAREA', 'SELECT'].includes(tag) || e.metaKey || e.ctrlKey) return;
      // gombon / soron álló fókusznál az Enter azt az elemet működteti, nem hagy jóvá
      const onControl = tag === 'BUTTON' || (e.target as HTMLElement)?.getAttribute?.('role') === 'button';
      if (onControl && (e.key === 'Enter' || e.key === 'k' || e.key === 'K')) return;
      const i = inbox.findIndex((t) => t.id === curOpen);
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        const n = inbox[i + (e.key === 'ArrowDown' ? 1 : -1)];
        if (n) {
          e.preventDefault();
          setOpenId(n.id);
        }
      } else if (e.key === 'Enter' && acts.current) {
        e.preventDefault();
        acts.current.approve();
      } else if ((e.key === 'k' || e.key === 'K') && acts.current) {
        e.preventDefault();
        acts.current.skip();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [inbox, curOpen, mobile, canEdit]);
  const inboxSum = inbox.reduce((a, t) => a + t.amount, 0);

  return (
    <div style={{ padding: mobile ? '14px 16px 120px' : '24px 28px 120px', display: 'flex', flexDirection: 'column', gap: 16 }}>
      {!mobile && (
        <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', gap: 16, flexWrap: 'wrap' }}>
          <div>
            <div style={{ font: `600 12px ${FONT}`, letterSpacing: '.18em', textTransform: 'uppercase', color: C.blue, marginBottom: 8 }}>Bankszinkron</div>
            <h1 style={{ margin: 0, font: `700 30px/1.05 ${FONT_H}`, color: C.navy }}>Beérkezett banki tételek</h1>
            <p style={{ margin: '8px 0 0', font: `400 14px/1.5 ${FONT}`, color: C.muted }}>
              Kategóriát javaslunk és tervvel (pl. Billingo-számlával) párosítunk · a tény a banki dátumra kerül · ismétlődőnél a következő hónapoktól terv is
              készül
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
          borderRadius: R.lg,
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
        {accounts.length > 0 && (
          <div
            style={{
              display: 'flex',
              flexDirection: 'column',
              paddingRight: mobile ? 0 : 28,
              marginRight: mobile ? 0 : 4,
              borderRight: mobile ? 0 : `1px solid ${C.navy3}`,
            }}
          >
            <span style={{ ...eyebrow, color: C.muted2 }}>Összesen · {stamp(lastSync)}</span>
            <span style={{ font: `800 28px ${FONT_H}`, fontVariantNumeric: 'tabular-nums' }}>{ix.bankBalance != null ? fmt(ix.bankBalance) + ' Ft' : '—'}</span>
            <span style={{ font: `500 12px ${FONT}`, color: C.muted2 }}>automatikusan: 5, 9, 13, 17, 21 órakor</span>
          </div>
        )}
        {accounts.map((a) => (
          <div key={a.id} style={{ display: 'flex', alignItems: 'center', gap: 12, minWidth: 220 }}>
            <div
              style={{
                width: 40,
                height: 40,
                borderRadius: R.lg,
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
                {a.last_error ? a.last_error : `szinkron: ${stamp(a.last_sync)}${a.valid_until ? ' · hozzájárulás: ' + a.valid_until.slice(0, 10) : ''}`}
              </span>
            </div>
          </div>
        ))}
      </div>

      {inbox.length === 0 && (
        <div style={{ ...card, padding: 36, textAlign: 'center', display: 'flex', flexDirection: 'column', gap: 6 }}>
          <span style={{ font: `700 18px ${FONT_H}`, color: C.navy }}>Minden tétel rendezve</span>
          <span style={{ font: `400 14px ${FONT}`, color: C.muted }}>Az új banki mozgások szinkronizálás után itt jelennek meg.</span>
        </div>
      )}

      {mobile && inbox.map((t) => <TxCard key={t.id} t={t} frequent={t.amount >= 0 ? freqIn : freqOut} unforeseen={unforeseen} mobile />)}
      {!mobile && inbox.length > 0 && (
        <>
          <div style={{ display: 'flex', gap: 22, alignItems: 'baseline', flexWrap: 'wrap', font: `400 14px ${FONT}`, color: C.muted, padding: '0 4px' }}>
            <span>
              <b style={{ color: C.navy }}>{inbox.length} tétel</b> vár jóváhagyásra
            </span>
            <span>
              összesen{' '}
              <b style={{ color: C.navy }}>
                {inboxSum > 0 ? '+' : inboxSum < 0 ? '−' : ''}
                {fmt(Math.abs(inboxSum))} Ft
              </b>
            </span>
            <span>
              <b style={{ color: C.blueDark }}>{inbox.filter((t) => t.leaf_id).length}</b> kategória javasolva
            </span>
            <span>
              <b style={{ color: C.navy }}>{inbox.filter((t) => t.plan_id).length}</b> tervhez párosítva
            </span>
            {canEdit && <span style={{ marginLeft: 'auto', font: `400 12.5px ${FONT}` }}>Enter = jóváhagy · K = kihagy · ↓ = következő</span>}
          </div>
          <div style={{ ...card, overflowX: 'auto' }}>
            <div style={{ display: 'grid', gridTemplateColumns: BANK_COLS, gap: 12, padding: '12px 18px 12px 21px', minWidth: BANK_MINW }}>
              {['Dátum', 'Bank', 'Partner · közlemény', 'Kategória', 'Terv', 'Ismétlődik', 'Összeg', ''].map((h, i) => (
                <span key={i} style={{ ...eyebrow, textAlign: i === 6 ? 'right' : 'left' }}>
                  {h}
                </span>
              ))}
            </div>
            {inbox.map((t) => (
              <TxCard
                key={t.id}
                t={t}
                frequent={t.amount >= 0 ? freqIn : freqOut}
                unforeseen={unforeseen}
                open={t.id === curOpen}
                onToggle={() => setOpenId(t.id === curOpen ? 'none' : t.id)}
                actions={t.id === curOpen ? acts : undefined}
              />
            ))}
          </div>
        </>
      )}
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

/** A leggyakoribb kategóriák az elmúlt évből (gyors választáshoz a banki tételnél): [bevétel, kiadás]. */
export function useFrequentLeaves(): [string[], string[]] {
  const { ix, data } = useStore();
  return useMemo(() => {
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
}
