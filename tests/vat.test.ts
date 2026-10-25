import { describe, expect, it } from 'vitest';
import { isVatLeaf, vatPlan } from '../shared/vat';

describe('ÁFA-terv', () => {
  const sec = (l: string) => (l === 'in' ? 'in' : 'out') as 'in' | 'out';
  const e = (kind: 'plan' | 'actual', date: string, amount: number, extra: { done?: number; tentative?: number; leaf_id?: string } = {}) => ({
    kind,
    date,
    leaf_id: extra.leaf_id || 'in',
    amount,
    done: extra.done || 0,
    tentative: extra.tentative || 0,
  });
  it('az előző havi bevétel 27/127-e, a következő hónapban; az ajánlat és a kiadás nem számít', () => {
    const p = vatPlan(
      [
        e('actual', '2026-10-05', 1_270_000),
        e('plan', '2026-10-20', 254_000),
        e('plan', '2026-10-21', 999_999, { tentative: 1 }),
        e('plan', '2026-11-10', 127_000),
        e('actual', '2026-10-06', -50_000, { leaf_id: 'out' }),
        e('plan', '2026-09-30', 500_000),
      ],
      sec,
      '2026-10',
      3,
    );
    expect(p.map((x) => x.ym)).toEqual(['2026-11', '2026-12', '2027-01']);
    expect(p[0]).toMatchObject({ base_ym: '2026-10', base: 1_524_000, vat: 324_000 });
    expect(p[1]).toMatchObject({ base_ym: '2026-11', vat: 27_000 });
    expect(p[2].vat).toBe(0);
  });
  it('ÁFA kategória felismerése', () => {
    expect(isVatLeaf('ÁFA')).toBe(true);
    expect(isVatLeaf('KIVA')).toBe(false);
  });
});
