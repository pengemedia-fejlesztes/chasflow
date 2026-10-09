import { describe, expect, it } from 'vitest';
import { planVsActual, pvaProfit } from '../shared/planactual';
import type { Entry } from '../shared/types';

const E = (p: Partial<Entry>): Entry => ({
  id: 'x',
  kind: 'plan',
  date: '2026-10-10',
  leaf_id: 'in',
  name: '',
  amount: 0,
  series_id: null,
  done: 0,
  tentative: 0,
  source: 'manual',
  ext_ref: null,
  link_id: null,
  note: null,
  ...p,
});
const sec = (l: string) => (l === 'in' ? 'in' : 'out') as 'in' | 'out';

describe('havi terv–tény összesítő', () => {
  it('tervezett és tényleges bevétel, kiadás, profit', () => {
    const es = [
      E({ amount: 1000000, done: 1 }),
      E({ kind: 'actual', amount: 950000 }),
      E({ amount: 200000 }), // nyitott bevételi terv
      E({ amount: 500000, tentative: 1 }), // ajánlat: nem számít a tervbe
      E({ leaf_id: 'out', amount: -40000, done: 1 }),
      E({ leaf_id: 'out', kind: 'actual', amount: -44000 }),
      E({ date: '2026-11-05', amount: 300000 }),
    ];
    const [o, n] = planVsActual(es, sec, ['2026-10', '2026-11']);
    expect(o).toMatchObject({ planIn: 1200000, actIn: 950000, planOut: 40000, actOut: 44000, openIn: 200000, hasPlan: true, hasActual: true });
    expect(pvaProfit(o)).toEqual({ plan: 1160000, act: 906000 });
    expect(n).toMatchObject({ planIn: 300000, actIn: 0, hasActual: false });
  });
});
