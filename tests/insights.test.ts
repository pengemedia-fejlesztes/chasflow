import { describe, expect, it } from 'vitest';
import { concentration, costStructure, liquidity, receivablesAging, revenueTrend } from '../shared/insights';
import { buildIndex, monthRange } from '../shared/model';
import type { Entry, Group, Leaf } from '../shared/types';

let n = 0;
const E = (p: Partial<Entry>): Entry => ({
  id: 'e' + n++,
  kind: 'actual',
  date: '2026-01-01',
  leaf_id: 'in',
  name: '',
  amount: 0,
  series_id: null,
  done: 0,
  tentative: 0,
  source: 'import',
  ext_ref: null,
  link_id: null,
  note: null,
  ...p,
});
const groups: Group[] = [
  { id: 'gi', section: 'in', label: 'Projektek', sort: 1 },
  { id: 'go', section: 'out', label: 'Működés', sort: 2 },
];
const leaves: Leaf[] = [
  { id: 'in', group_id: 'gi', label: 'Ügyfél', sort: 1, archived: 0 },
  { id: 'out', group_id: 'go', label: 'Iroda', sort: 1, archived: 0 },
];

describe('statisztikák', () => {
  const es: Entry[] = [];
  for (const ym of monthRange('2024-10', '2026-09')) {
    es.push(E({ date: ym + '-05', amount: ym >= '2025-10' ? 1000000 : 800000 }));
    es.push(E({ date: ym + '-10', leaf_id: 'out', amount: -1200000 }));
  }
  const ix = buildIndex({ groups, leaves, entries: es, accounts: [], settings: { opening_balance: '0' }, today: '2026-10-09' });
  it('likviditás: 3 havi nettó és runway', () => {
    const l = liquidity({ ...ix, anchor: 2000000 } as any);
    expect(l.net3).toBe(-200000);
    expect(l.runway).toBe(10);
    expect(l.coverMonths).toBeCloseTo(2000000 / 1200000);
  });
  it('bevétel-trend és éves változás', () => {
    const t = revenueTrend(ix, 24);
    expect(t.last12).toBe(12000000);
    expect(t.prev12).toBe(9600000);
    expect(t.yoy).toBeCloseTo(0.25);
    expect(t.rows.at(-1)!.ma3).toBe(1000000);
  });
  it('költségszerkezet', () => {
    const c = costStructure(ix);
    expect(c.total).toBe(14400000);
    expect(c.groups[0]).toMatchObject({ label: 'Működés', last12: 14400000, prev12: 14400000 });
  });
  it('koncentráció', () => {
    const k = concentration([
      { name: 'A', v: 70 },
      { name: 'B', v: 20 },
      { name: 'C', v: 10 },
    ]);
    expect(k.top1).toBeCloseTo(0.7);
    expect(k.hhi).toBe(4900 + 400 + 100);
  });
  it('kintlévőségek kora', () => {
    const a = receivablesAging(
      [
        E({ kind: 'plan', date: '2026-10-01', amount: 100 }),
        E({ kind: 'plan', date: '2026-07-01', amount: 200 }),
        E({ kind: 'plan', date: '2026-10-20', amount: 300 }),
        E({ kind: 'plan', date: '2026-10-01', amount: 999, tentative: 1 }),
      ],
      (l) => (l === 'in' ? 'in' : 'out'),
      '2026-10-09',
    );
    expect(a.buckets.find((b) => b.key === 'd30')!.sum).toBe(100);
    expect(a.buckets.find((b) => b.key === 'old')!.sum).toBe(200);
    expect(a.buckets.find((b) => b.key === 'notdue')!.sum).toBe(300);
    expect(a.overdue).toBe(300);
  });
  it('kintlévőségek kora: a Billingo szerint ki nem fizetett számla akkor is, ha a terve lezárult', () => {
    const doc = (id: number, plan_id: string | null, payment_status: string, due_date: string) => ({
      id,
      number: `Penge / ${id}`,
      partner: 'Balogh',
      gross: 228600,
      currency: 'HUF',
      invoice_date: due_date,
      due_date,
      payment_status,
      paid_date: null,
      cancelled: 0,
      plan_id,
    });
    const a = receivablesAging(
      [E({ id: 'pDone', kind: 'plan', date: '2025-12-10', amount: 228600, done: 1 }), E({ id: 'pOpen', kind: 'plan', date: '2026-10-01', amount: 500 })],
      (l) => (l === 'in' ? 'in' : 'out'),
      '2026-10-25',
      [doc(1, 'pDone', 'expired', '2025-12-10'), doc(2, 'pOpen', 'expired', '2026-10-01'), doc(3, null, 'paid', '2025-12-10')],
    );
    const old = a.buckets.find((b) => b.key === 'old')!;
    expect(old.sum).toBe(228600);
    expect(old.items[0].leaf_id).toBe('in');
    // a nyitott terv nem duplázódik a számlával
    expect(a.buckets.find((b) => b.key === 'd30')!.sum).toBe(500);
  });
});

import { offerConversion, seasonality, targetTracking } from '../shared/insights';
describe('további statisztikák', () => {
  it('ajánlatok megvalósulása', () => {
    const s = offerConversion(
      [
        E({ kind: 'plan', was_offer: 1, tentative: 0, amount: 500 }),
        E({ kind: 'plan', was_offer: 1, tentative: 1, date: '2026-10-20', amount: 300 }),
        E({ kind: 'plan', was_offer: 1, tentative: 1, date: '2026-06-01', amount: 100 }),
      ],
      [{ id: 'x', name: 'Elveszett', leaf_id: 'in', amount: 200, date: '2026-05-01' }],
      '2026-10-09',
    );
    expect(s.rate).toBe(0.5);
    expect(s.open.length).toBe(1);
    expect(s.expired.length).toBe(1);
    expect(s.wonSum).toBe(500);
  });
  it('ajánlat-arány ajánlatonként (sorozat = 1 ajánlat), elutasításig eltelt idő', () => {
    const won = [1, 2, 3, 4, 5, 6].map((i) => E({ id: 'w' + i, kind: 'plan', was_offer: 1, tentative: 0, series_id: 's1', amount: 100 }));
    const lost = [1, 2].map((i) => ({ id: 'l' + i, name: 'Weboldal', leaf_id: 'in', series_id: 's2', amount: 50, date: '2026-05-01', offer_at: 0 + 1, deleted_at: 1 + 10 * 86400000 }));
    const s = offerConversion(won, lost, '2026-10-09');
    expect(s.wonN).toBe(1);
    expect(s.lostN).toBe(1);
    expect(s.rate).toBe(0.5);
    expect(s.rejectDays).toBe(10);
  });
  it('eredmény-cél és szezonalitás', () => {
    const ix2 = buildIndex({
      groups,
      leaves,
      entries: [E({ date: '2026-09-05', amount: 300 }), E({ date: '2026-08-05', amount: 100 })],
      accounts: [],
      settings: {},
      today: '2026-10-09',
    });
    const t = targetTracking(ix2, 200, ['2026-08', '2026-09']);
    expect(t.map((x) => x.ok)).toEqual([false, true]);
    const s = seasonality(ix2);
    expect(s.rows[8].inc).toBe(300);
    expect(s.rows[8].index).toBeGreaterThan(100);
  });
});
