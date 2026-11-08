import { describe, expect, it } from 'vitest';
import { billableIn, billablesFor, cleanProfile, effective, grossOf, monthlyValue, nextBilling, type PartnerProduct, type Product } from '../shared/catalog';

const prod = (o: Partial<Product> = {}): Product => ({
  id: 'p1',
  name: 'Google Ads kezelés',
  kind: 'szolgaltatas',
  unit: 'hó',
  price: 100000,
  vat: '27',
  currency: 'HUF',
  billing: 'havi',
  sku: null,
  note: null,
  archived: 0,
  updated_at: 1,
  ...o,
});
const asg = (o: Partial<PartnerProduct> = {}): PartnerProduct => ({
  id: 'a1',
  partner_key: 'kalmia',
  product_id: 'p1',
  qty: 1,
  price: null,
  billing: null,
  start_ym: '2026-11',
  end_ym: null,
  note: null,
  updated_at: 1,
  ...o,
});

describe('terméktörzs: számlázási ütem', () => {
  it('havi: a kezdő hónaptól minden hónapban, a záró hónapig', () => {
    const a = asg({ end_ym: '2027-01' });
    expect(['2026-10', '2026-11', '2026-12', '2027-01', '2027-02'].map((m) => billableIn(a, 'havi', m))).toEqual([false, true, true, true, false]);
  });
  it('negyedéves és éves: a kezdő hónaptól lépésközzel', () => {
    expect(['2026-11', '2026-12', '2027-02', '2027-05'].map((m) => billableIn(asg(), 'negyedeves', m))).toEqual([true, false, true, true]);
    expect(['2026-11', '2027-10', '2027-11'].map((m) => billableIn(asg(), 'eves', m))).toEqual([true, false, true]);
  });
  it('egyszeri: csak a kezdő hónapban', () => {
    expect(['2026-11', '2026-12'].map((m) => billableIn(asg(), 'egyszeri', m))).toEqual([true, false]);
  });
  it('egyedi ár és ütem felülírja a törzset; bruttó az ÁFA szerint', () => {
    const e = effective(asg({ qty: 2, price: 50000, billing: 'negyedeves' }), prod());
    expect(e).toEqual({ price: 50000, billing: 'negyedeves', net: 100000, gross: 127000 });
    expect(grossOf(1000, 'AAM')).toBe(1000);
    expect(monthlyValue(300000, 'negyedeves')).toBe(100000);
    expect(monthlyValue(300000, 'egyszeri')).toBe(0);
  });
  it('havi lista partnerenként és következő számlázás', () => {
    const list = billablesFor('2026-12', [asg(), asg({ id: 'a2', partner_key: 'mrbig', billing: 'eves' })], [prod()]);
    expect(list.map((l) => l.assign.partner_key)).toEqual(['kalmia']);
    expect(nextBilling(asg({ billing: 'eves' }), 'eves', '2026-12')).toBe('2027-11');
    expect(nextBilling(asg({ end_ym: '2026-11' }), 'havi', '2026-12')).toBeNull();
  });
  it('számlázási adatok tisztítása', () => {
    const p = cleanProfile({ company: '  Kalmia   Kft. ', pay_days: '8', evil: 'x', zip: 1234 });
    expect(p.company).toBe('Kalmia Kft.');
    expect(p.pay_days).toBe(8);
    expect(p.zip).toBe('1234');
    expect((p as any).evil).toBeUndefined();
    expect(cleanProfile({ pay_days: '' }).pay_days).toBeNull();
  });
});
