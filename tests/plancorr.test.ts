import { describe, expect, it } from 'vitest';
import { computeFlags } from '../shared/flags';
import { buildEstimates, buildIndex, planCorrections } from '../shared/model';
import type { Entry } from '../shared/types';

const E = (p: Partial<Entry>): Entry =>
  ({
    id: 'x',
    kind: 'actual',
    date: '2026-10-01',
    leaf_id: 'p',
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
  }) as Entry;
const base = {
  groups: [{ id: 'g', section: 'in', label: 'Projektek', sort: 0 }],
  leaves: [{ id: 'p', group_id: 'g', label: 'Partner', sort: 0, archived: 0 }],
  accounts: [],
  settings: {},
  today: '2026-10-31',
} as any;

describe('terv-korrekció (becslés)', () => {
  // régi partner: havi díj terv 100 000, a számla 120 000 → a jövőbeli tervhónapokra a 90 napos átlag a becslés
  const hist = [
    E({ id: 'a1', date: '2026-08-10', amount: 120000 }),
    E({ id: 'a2', date: '2026-09-10', amount: 120000 }),
    E({ id: 'a3', date: '2026-10-10', amount: 120000 }),
    E({ id: 'a0', date: '2026-03-10', amount: 100000 }),
  ];
  const plan = E({ id: 'pl', kind: 'plan', date: '2026-10-10', amount: 100000, plan_amount: 100000, bill_amount: 120000, done: 1, link_id: 'a3' });
  const fut = E({ id: 'f1', kind: 'plan', date: '2026-12-10', amount: 100000 });

  it('200 Ft-nál nagyobb eltérés → becslés a 90 nap átlagából, a terv marad', () => {
    const ix = buildIndex({ ...base, entries: [...hist, plan, fut] });
    expect(planCorrections(ix).get('p')).toBe(120000);
    const est = buildEstimates(ix, '2026-12');
    expect(est.get('p')?.get('2026-12')).toBe(20000);
    expect(ix.plan.get('p')?.get('2026-12')).toBe(100000);
  });
  it('200 Ft-on belül pontos a terv → nincs korrekció', () => {
    const ix = buildIndex({ ...base, entries: [...hist, { ...plan, bill_amount: 100150 }, fut] });
    expect(planCorrections(ix).has('p')).toBe(false);
  });
  it('új partner → az elmúlt 30 nap', () => {
    const ix = buildIndex({
      ...base,
      entries: [E({ id: 'n1', date: '2026-10-20', amount: 80000 }), { ...plan, link_id: 'n1', bill_amount: 80000, date: '2026-10-20' }, fut],
    });
    expect(planCorrections(ix).get('p')).toBe(80000);
  });
});

describe('fizetés a számlához mérve', () => {
  const sec = () => 'in' as const;
  it('kevesebbet utalt, mint a számla → jelzés (forintra)', () => {
    const plan = E({ id: 'pl', kind: 'plan', date: '2026-10-25', amount: 100000, bill_amount: 120000, done: 1, link_id: 'a' });
    const f = computeFlags([plan, E({ id: 'a', date: '2026-10-28', amount: 119000, link_id: 'pl' })], [], sec, '2026-10-31');
    expect(f[0].kind).toBe('deviation');
    expect(f[0].vsInvoice).toBe(true);
    expect(f[0].diff).toBe(-1000);
    expect(computeFlags([plan, E({ id: 'a', date: '2026-10-28', amount: 120000, link_id: 'pl' })], [], sec, '2026-10-31')).toHaveLength(0);
  });
});
