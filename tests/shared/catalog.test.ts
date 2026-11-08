import { describe, expect, it } from 'vitest';
import { billableIn, billablesFor, cleanProfile, effective, grossOf, monthlyValue, nextBilling, type PartnerProduct, type Product } from '../../src/shared/catalog';

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

import { deriveCatalog, productNameOf } from '../../src/shared/catalog';
import { partnerIdOf } from '../../src/shared/partners';

describe('törzs a partnerek tételeiből', () => {
  it('terméknév: hónap, partner-előtag, részlet és előleg nélkül; számlaszám kimarad', () => {
    expect(productNameOf('Marketing tanácsadás – 2026. november', 'Kalmia')).toBe('Marketing tanácsadás');
    expect(productNameOf('Orvosmost - Marketing tanácsadás', 'Orvosmost')).toBe('Marketing tanácsadás');
    expect(productNameOf('Weboldal készítése – 1. részlet', 'X')).toBe('Weboldal készítése');
    expect(productNameOf('SEO oktatás - 1 rész', 'BWT')).toBe('SEO oktatás');
    expect(productNameOf('Weboldal készítés - előleg', 'E')).toBe('Weboldal készítés');
    expect(productNameOf('Penge / 2026-000001', 'Balogh')).toBeNull();
  });
  it('havi sorozat, havonta kétszer szereplő tétel = 2 db, részletek = egy egyszeri tétel, ajánlat külön jelölve', () => {
    const leaves = [
      { id: 'k', label: 'Kalmia', section: 'in' as const, offer: false },
      { id: 'n', label: 'Naturtex', section: 'in' as const, offer: false },
      { id: 'h', label: 'hitelespenzugyek', section: 'in' as const, offer: true },
      { id: 'o', label: 'Rackforest', section: 'out' as const, offer: false },
    ];
    const plans = [
      ...['2026-11', '2026-12', '2027-01'].map((m) => ({ leaf_id: 'k', name: 'Marketing tanácsadás', amount: 1497000, date: m + '-11', series_id: 's1' })),
      ...['2026-12', '2027-01'].flatMap((m) => [
        { leaf_id: 'n', name: 'Marketing feladatok', amount: 609000, date: m + '-09', series_id: 's2' },
        { leaf_id: 'n', name: 'Marketing feladatok', amount: 609000, date: m + '-09', series_id: 's3' },
      ]),
      { leaf_id: 'h', name: 'Weboldal készítése – 1. részlet', amount: 490000, date: '2026-11-10' },
      { leaf_id: 'h', name: 'Weboldal készítése – 2. részlet', amount: 490000, date: '2026-12-08' },
      { leaf_id: 'o', name: 'Tárhely', amount: -8000, date: '2026-12-01' },
      { leaf_id: 'k', name: 'Régi', amount: 1000, date: '2026-01-01' },
    ];
    const d = deriveCatalog(leaves, plans, { s1: 'monthly', s2: 'monthly', s3: 'monthly' }, '2026-11', partnerIdOf);
    expect(d.products.map((p) => p.name)).toEqual(['Marketing feladatok', 'Marketing tanácsadás', 'Weboldal készítése']);
    const k = d.assigns.find((a) => a.partner_key === 'kalmia')!;
    expect(k).toMatchObject({ qty: 1, price: 1178740, billing: 'havi', start_ym: '2026-11', end_ym: '2027-01', offer: false });
    expect(d.assigns.find((a) => a.partner_key === 'naturtex')).toMatchObject({ qty: 2, price: 479528, billing: 'havi' });
    expect(d.assigns.find((a) => a.partner_key === 'hitelespenzugyek')).toMatchObject({ qty: 1, price: 771654, billing: 'egyszeri', offer: true });
  });
});
