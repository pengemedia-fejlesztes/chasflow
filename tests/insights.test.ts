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
});
