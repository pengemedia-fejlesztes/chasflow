import { describe, expect, it } from 'vitest';
import { computeFlags, flagsFrom } from '../shared/flags';
import type { Entry } from '../shared/types';

const E = (p: Partial<Entry>): Entry => ({
  id: 'x',
  kind: 'actual',
  date: '2026-10-01',
  leaf_id: 'aranka',
  name: '',
  amount: 0,
  series_id: null,
  done: 0,
  tentative: 0,
  source: 'bank',
  ext_ref: null,
  link_id: null,
  note: null,
  ...p,
});
const sec = (l: string) => (l === 'ugyfel' ? 'in' : 'out') as 'in' | 'out';
const today = '2026-11-20';
const hist = E({ id: 'h', source: 'import', date: '2026-10-09', amount: -5 });

describe('riasztások', () => {
  it('a figyelt időszak az utolsó XLS-tény után / előző hónap elején kezdődik', () => {
    expect(flagsFrom([hist], '2026-10-20')).toBe('2026-10-10');
    expect(flagsFrom([hist], today)).toBe('2026-10-10');
    expect(flagsFrom([hist], '2026-12-15')).toBe('2026-11-01');
  });

  it('Aranka 40 000 helyett 44 000 → eltérés', () => {
    const plan = E({ id: 'p', kind: 'plan', date: '2026-10-30', amount: -40000, done: 1, link_id: 'a', name: 'Baka Aranka' });
    const act = E({ id: 'a', date: '2026-10-30', amount: -44000, link_id: 'p' });
    const f = computeFlags([hist, plan, act], [], sec, today);
    expect(f).toHaveLength(1);
    expect(f[0]).toMatchObject({ kind: 'deviation', diff: -4000, plan: -40000 });
    // pontos egyezés vagy küszöb alatti eltérés nem riaszt
    expect(computeFlags([hist, plan, { ...act, amount: -40000 }], [], sec, today)).toHaveLength(0);
    expect(computeFlags([hist, plan, { ...act, amount: -40300 }], [], sec, today)).toHaveLength(0);
  });

  it('nem tervezett kiadás és elmaradt bevétel; XLS-tény és jövőbeli terv nem riaszt; „rendben” eltünteti', () => {
    const unp = E({ id: 'u', date: '2026-11-03', amount: -120000, leaf_id: 'elore' });
    const due = E({ id: 'd', kind: 'plan', date: '2026-11-10', amount: 500000, leaf_id: 'ugyfel' });
    const fut = E({ id: 'f', kind: 'plan', date: '2026-11-25', amount: 500000, leaf_id: 'ugyfel' });
    const old = E({ id: 'o', source: 'import', date: '2026-10-05', amount: -99 });
    const f = computeFlags([hist, unp, due, fut, old], [], sec, today);
    expect(f.map((x) => x.kind)).toEqual(['unplanned', 'overdue']);
    expect(f[1].section).toBe('in');
    expect(computeFlags([hist, unp, due, fut], [], sec, today, [f[0].id, f[1].id])).toHaveLength(0);
  });

  it('a lejárt Billingo-számla régebbről is riaszt, az összevont havi tétel csak hónap végén', () => {
    const bil = E({ id: 'b', kind: 'plan', source: 'billingo', date: '2026-08-15', amount: 300000, leaf_id: 'ugyfel' });
    const plan = E({ id: 'p', kind: 'plan', date: '2026-11-02', amount: -20000, done: 1, leaf_id: 'bank' });
    const merged = E({ id: 'm', date: '2026-11-18', amount: -12000, link_id: 'p', ext_ref: 'merge:m', leaf_id: 'bank' });
    expect(computeFlags([hist, bil, plan, merged], [], sec, today).map((x) => x.kind)).toEqual(['overdue']);
    expect(computeFlags([hist, bil, plan, merged], [], sec, '2026-12-03').map((x) => x.kind)).toEqual(['deviation', 'overdue']);
  });
});
