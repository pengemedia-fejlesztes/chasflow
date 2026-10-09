// Törölt tételek (kuka): a törölt ajánlatok, tervek, tények visszakeresése és visszaállítása.
import { useEffect, useMemo, useState } from 'react';
import { normalizeText } from '../../shared/categories';
import { fmt } from '../../shared/model';
import { api } from './api';
import { useStore } from './store';
import { C, FONT, Pill, Seg, card, inputStyle, relTime } from './ui';

interface TrashRow {
  rid: number;
  id: string;
  kind: 'actual' | 'plan';
  date: string;
  name: string;
  amount: number;
  tentative: number;
  leaf_label: string | null;
  note: string | null;
  deleted_at: number;
  deleted_by_name: string | null;
}

export function TrashTab() {
  const { canEdit, run } = useStore();
  const [q, setQ] = useState('');
  const [only, setOnly] = useState<'offers' | 'all'>('offers');
  const [items, setItems] = useState<TrashRow[] | null>(null);
  const [n, setN] = useState(0);

  useEffect(() => {
    api<{ items: TrashRow[] }>(`/api/trash?offers=${only === 'offers' ? 1 : 0}`)
      .then((r) => setItems(r.items))
      .catch(() => setItems([]));
  }, [only, n]);

  // ékezetfüggetlen keresés névre, kategóriára, megjegyzésre, összegre
  const shown = useMemo(() => {
    if (!items) return null;
    const words = normalizeText(q).split(/\s+/).filter(Boolean);
    if (!words.length) return items.slice(0, 300);
    return items
      .filter((r) => {
        const hay = normalizeText(`${r.name} ${r.leaf_label || ''} ${r.note || ''} ${r.date} ${Math.abs(r.amount)} ${fmt(Math.abs(r.amount))}`);
        return words.every((w) => hay.includes(w));
      })
      .slice(0, 300);
  }, [items, q]);

  const restore = (rows: TrashRow[]) =>
    run(() => api('/api/trash/restore', { body: { rids: rows.map((r) => r.rid) } }), `${rows.length} tétel visszaállítva`).then(() => setN((x) => x + 1));

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <span style={{ font: `400 13px/1.5 ${FONT}`, color: C.muted }}>
        Minden törölt ajánlat, terv és tény ide kerül: kereshető névre, kategóriára vagy összegre, és egy kattintással visszaállítható.
      </span>
      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Keresés: ügyfél, kategória, összeg…"
          style={{ ...inputStyle, flex: '1 1 260px' }}
        />
        <Seg
          small
          value={only}
          onChange={setOnly}
          options={[
            ['offers', 'Ajánlatok'],
            ['all', 'Minden törölt'],
          ]}
        />
      </div>
      {shown === null && <span style={{ font: `500 13px ${FONT}`, color: C.muted }}>Betöltés…</span>}
      {shown && !shown.length && (
        <div style={{ ...card, padding: '18px 20px', font: `500 13.5px ${FONT}`, color: C.muted }}>
          {q ? 'Nincs találat.' : only === 'offers' ? 'Még nincs törölt ajánlat.' : 'Még nincs törölt tétel.'}
        </div>
      )}
      {shown?.map((r) => (
        <div key={r.rid} style={{ ...card, padding: '11px 16px', display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
          <div style={{ flex: '1 1 240px', minWidth: 0, display: 'flex', flexDirection: 'column', gap: 3 }}>
            <span style={{ font: `600 14px ${FONT}`, color: C.ink }}>
              {r.name || r.leaf_label || 'Tétel'}
              {r.tentative ? (
                <span style={{ marginLeft: 8, font: `600 11px ${FONT}`, color: C.blueDark, background: C.bg2, borderRadius: 6, padding: '2px 6px' }}>
                  ajánlat
                </span>
              ) : null}
              {r.kind === 'actual' ? (
                <span style={{ marginLeft: 8, font: `600 11px ${FONT}`, color: C.muted, background: C.bg, borderRadius: 6, padding: '2px 6px' }}>tény</span>
              ) : null}
            </span>
            <span style={{ font: `400 12.5px ${FONT}`, color: C.muted }}>
              {r.date.replace(/-/g, '.')}. · {r.leaf_label || 'ismeretlen kategória'} · törölte: {r.deleted_by_name || 'rendszer'},{' '}
              {new Date(r.deleted_at).toLocaleString('hu-HU', { dateStyle: 'short', timeStyle: 'short' })} ({relTime(r.deleted_at)})
            </span>
          </div>
          <span style={{ font: `700 14.5px ${FONT}`, fontVariantNumeric: 'tabular-nums', color: r.amount < 0 ? C.neg : C.navy }}>
            {r.amount > 0 ? '+' : r.amount < 0 ? '−' : ''}
            {fmt(Math.abs(r.amount))} Ft
          </span>
          {canEdit && (
            <Pill small kind="light" onClick={() => restore([r])}>
              Visszaállítás
            </Pill>
          )}
        </div>
      ))}
      {shown && shown.length >= 300 && <span style={{ font: `400 12px ${FONT}`, color: C.muted }}>Az első 300 találat látszik – szűkítsd a keresést.</span>}
    </div>
  );
}
