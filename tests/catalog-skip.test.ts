import { describe, expect, it } from 'vitest';
import { billableIn, billablesFor, type PartnerProduct, type Product } from '../shared/catalog';

describe('partner-szolgáltatás: kihagyott hónapok', () => {
  const a = { start_ym: '2026-11', end_ym: null, skip: ['2027-11'] };
  it('az éves számlázás a kihagyott hónapban nem számlázandó', () => {
    expect(billableIn(a, 'eves', '2026-11')).toBe(true);
    expect(billableIn(a, 'eves', '2027-11')).toBe(false);
    expect(billableIn(a, 'eves', '2028-11')).toBe(true);
  });
  it('a kiszámlázandó lista is figyelembe veszi', () => {
    const prod: Product = { id: 'p1', name: 'Domain', kind: 'szolgaltatas', unit: 'db', price: 37800, vat: '27', currency: 'HUF', billing: 'eves', sku: null, note: null, archived: 0, updated_at: 0 } as Product;
    const pp: PartnerProduct = { id: 'a1', partner_key: 'x', product_id: 'p1', qty: 1, price: null, billing: null, start_ym: '2026-11', end_ym: null, note: null, skip: ['2027-11'], updated_at: 0 };
    expect(billablesFor('2026-11', [pp], [prod])).toHaveLength(1);
    expect(billablesFor('2027-11', [pp], [prod])).toHaveLength(0);
  });
});
