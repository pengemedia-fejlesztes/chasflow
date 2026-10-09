import { describe, expect, it } from 'vitest';
import { partnerStats } from '../shared/partners';
import type { BillingoDoc, Entry, Group, Leaf } from '../shared/types';

const E = (p: Partial<Entry>): Entry => ({
  id: Math.random().toString(36),
  kind: 'actual',
  date: '2026-10-01',
  leaf_id: 'mb',
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
  { id: 'go', section: 'out', label: 'Alvállalkozók', sort: 2 },
];
const leaves: Leaf[] = [
  { id: 'mb', group_id: 'gi', label: 'Mr. Big', sort: 1, archived: 0 },
  { id: 'mbo', group_id: 'go', label: 'Mr Big', sort: 1, archived: 0 }, // ugyanaz a partner kiadási oldalon
  { id: 'ph', group_id: 'gi', label: 'Pharmazone', sort: 2, archived: 0 },
];

describe('partnerstatisztika', () => {
  it('bevétel + kiadás egy partnernél, múlt, jövő, összetevők, számlák', () => {
    const es = [
      E({ amount: 100000, date: '2026-09-05', name: 'Marketing tanácsadás' }),
      E({ amount: 150000, date: '2026-10-06', name: 'Marketing tanácsadás' }),
      E({ amount: 200000, date: '2024-05-01', name: 'Kampány' }),
      E({ leaf_id: 'mbo', amount: -30000, date: '2026-09-20', name: 'Visszaszámlázás' }),
      E({ leaf_id: 'ph', amount: 750000, date: '2026-08-10' }),
      E({ kind: 'plan', amount: 80000, date: '2026-11-10', name: 'Marketing tanácsadás' }),
      E({ kind: 'plan', amount: 500000, date: '2026-12-01', tentative: 1, name: 'Új projekt' }),
    ];
    const docs = [
      {
        id: 1,
        number: 'P/1',
        partner: 'MR. BIG TEAM KFT.',
        gross: 100000,
        due_date: '2026-09-01',
        paid_date: '2026-09-05',
        payment_status: 'paid',
        cancelled: 0,
      },
      { id: 2, number: 'P/2', partner: 'MR. BIG TEAM KFT.', gross: 80000, due_date: '2026-10-01', paid_date: null, payment_status: 'expired', cancelled: 0 },
    ] as BillingoDoc[];
    const st = partnerStats(es, leaves, groups, docs, '2026-10-09', [{ leaf_id: 'mb', partner: 'MR. BIG TEAM KFT', n: 5 }]);
    const mb = st.find((p) => p.key === 'mrbig')!;
    expect(mb.leaves.map((l) => l.id).sort()).toEqual(['mb', 'mbo']);
    expect(mb.sides.in).toMatchObject({ total: 450000, last12: 250000, count: 3, openPlan: 80000, offers: 500000 });
    expect(mb.sides.out).toMatchObject({ total: 30000, count: 1 });
    expect(mb.sides.in!.share12).toBeCloseTo(0.25);
    expect(mb).toMatchObject({ avgLate: 4, lateCount: 1, outstanding: 80000, last: '2026-10-06', first: '2024-05-01' });
    expect(mb.future.map((e) => e.name)).toEqual(['Marketing tanácsadás', 'Új projekt']);
    expect(mb.pastComponents[0]).toMatchObject({ name: 'Marketing tanácsadás', total: 250000, count: 2 });
    expect(mb.billingNames.map((b) => b.source)).toEqual(['bank', 'Billingo']);
    expect(mb.byYear['2026']).toEqual({ inc: 250000, out: 30000 });
  });
});
