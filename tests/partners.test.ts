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
  { id: 'ph', group_id: 'gi', label: 'Pharmazone', sort: 2, archived: 0 },
  { id: 'zu', group_id: 'go', label: 'Zuban Erna', sort: 1, archived: 0 },
];

describe('partnerstatisztika', () => {
  it('összegek, részesedés, évek, fizetési késés', () => {
    const es = [
      E({ amount: 100000, date: '2026-09-05' }),
      E({ amount: 150000, date: '2026-10-06' }),
      E({ amount: 200000, date: '2024-05-01' }),
      E({ leaf_id: 'ph', amount: 750000, date: '2026-08-10' }),
      E({ leaf_id: 'zu', amount: -280000, date: '2026-09-30' }),
      E({ kind: 'plan', amount: 80000, date: '2026-11-10' }),
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
    const st = partnerStats(es, leaves, groups, docs, '2026-10-09');
    const mb = st.find((p) => p.leaf.id === 'mb')!;
    expect(mb).toMatchObject({
      total: 450000,
      last12: 250000,
      count: 3,
      last: '2026-10-06',
      first: '2024-05-01',
      openPlan: 80000,
      avgLate: 4,
      lateCount: 1,
      outstanding: 80000,
    });
    expect(mb.byYear).toEqual({ '2024': 200000, '2026': 250000 });
    expect(mb.share12).toBeCloseTo(0.25);
    expect(st.find((p) => p.leaf.id === 'zu')).toMatchObject({ section: 'out', total: 280000, share12: 1 });
  });
});
