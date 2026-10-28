// Lezárt (elutasított) ajánlatok: nincsenek a tervben, áthúzva látszanak, mennyi idő után zártuk le őket.
import { useMemo } from 'react';
import { fmt } from '../../shared/model';
import type { LostOffer } from '../../shared/types';
import { useStore } from './store';
import { C, FONT } from './ui';

export interface RejectedOffer {
  key: string;
  name: string;
  leaf_id: string;
  n: number;
  sum: number;
  from: string;
  to: string;
  offer_at: number | null;
  rejected_at: number;
  /** ajánlattól az elutasításig eltelt napok (ha ismert a felvitel ideje) */
  days: number | null;
}

/** Az elutasított tételek ajánlatonként összevonva (egy sorozat / név = egy ajánlat), a legutóbb lezárt elöl. */
export function groupRejected(lost: LostOffer[]): RejectedOffer[] {
  const m = new Map<string, RejectedOffer>();
  for (const e of lost) {
    const key = e.leaf_id + '|' + (e.series_id || e.name || '');
    const x = m.get(key) || {
      key,
      name: e.name || '(név nélkül)',
      leaf_id: e.leaf_id,
      n: 0,
      sum: 0,
      from: e.date,
      to: e.date,
      offer_at: null,
      rejected_at: e.deleted_at,
      days: null,
    };
    x.n++;
    x.sum += Math.abs(e.amount);
    if (e.date < x.from) x.from = e.date;
    if (e.date > x.to) x.to = e.date;
    if (e.offer_at && (!x.offer_at || e.offer_at < x.offer_at)) x.offer_at = e.offer_at;
    if (e.deleted_at > x.rejected_at) x.rejected_at = e.deleted_at;
    m.set(key, x);
  }
  for (const x of m.values()) x.days = x.offer_at && x.rejected_at >= x.offer_at ? Math.round((x.rejected_at - x.offer_at) / 86400000) : null;
  return [...m.values()].sort((a, b) => b.rejected_at - a.rejected_at);
}

const dot = (d: string) => d.replace(/-/g, '.') + '.';
const day = (ms: number) => new Date(ms).toLocaleDateString('hu-HU');

/** Áthúzott sorok a lezárt ajánlatokhoz – a megadott partner(ek) tételeiből. */
export function RejectedOffers({ leafIds, showLeaf }: { leafIds: string[]; showLeaf?: boolean }) {
  const { data, ix } = useStore();
  const key = leafIds.join(',');
  const rows = useMemo(() => {
    const set = new Set(leafIds);
    return groupRejected((data.lostOffers || []).filter((e) => set.has(e.leaf_id)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data.lostOffers, key]);
  if (!rows.length) return null;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
      <span style={{ font: `600 10.5px ${FONT}`, letterSpacing: '.08em', textTransform: 'uppercase', color: C.muted }}>
        Lezárt ajánlatok – nem lett elfogadva ({rows.length})
      </span>
      {rows.map((r) => (
        <div
          key={r.key}
          title="Elutasított ajánlat – nincs a tervben. Visszaállítani a Lomtárból lehet."
          style={{ display: 'flex', gap: 10, alignItems: 'baseline', flexWrap: 'wrap', padding: '5px 0', borderTop: `1px solid ${C.line3}` }}
        >
          <span style={{ flex: '1 1 220px', minWidth: 0, display: 'flex', flexDirection: 'column' }}>
            <s style={{ font: `600 13px ${FONT}`, color: C.muted }}>
              {r.name}
              {showLeaf && ix.leafById[r.leaf_id] ? ` · ${ix.leafById[r.leaf_id].label}` : ''}
            </s>
            <span style={{ font: `500 11.5px ${FONT}`, color: C.muted }}>
              <b style={{ color: '#B3261E' }}>✕ elutasítva {day(r.rejected_at)}</b>
              {r.days !== null ? ` · ${r.days} nap után zártad le` : ''} · {r.n} alkalom ({dot(r.from)}
              {r.to !== r.from ? ` – ${dot(r.to)}` : ''})
            </span>
          </span>
          <s style={{ font: `700 13px ${FONT}`, color: C.muted, fontVariantNumeric: 'tabular-nums' }}>{fmt(r.sum)} Ft</s>
        </div>
      ))}
    </div>
  );
}
