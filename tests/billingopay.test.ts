import { describe, expect, it } from 'vitest';
import { matchPayments } from '../shared/billingopay';

const tx = (o: Partial<any>) => ({ id: 't1', date: '2026-10-20', amount: 127000, currency: 'HUF', partner: '', memo: '', ...o });
const doc = (o: Partial<any>) => ({
  id: 1,
  number: 'PM-2026-000123',
  partner: 'Orvosmost Kft.',
  gross: 127000,
  currency: 'HUF',
  invoice_date: '2026-10-05',
  ...o,
});

describe('Billingo automatikus fizetettre állítás', () => {
  it('partner neve + pontos összeg', () => {
    expect(matchPayments([tx({ partner: 'ORVOSMOST KFT' })], [doc({})])).toHaveLength(1);
  });
  it('számlaszám a közleményben, más partnernévvel is', () => {
    const m = matchPayments([tx({ partner: 'Kovács Péter', memo: 'Szla: PM-2026-000123' })], [doc({}), doc({ id: 2, number: 'PM-2026-000124' })]);
    expect(m.map((x) => x.doc.id)).toEqual([1]);
  });
  it('sorszám előtag nélkül a közleményben', () => {
    expect(matchPayments([tx({ partner: 'X', memo: 'szla 2026/000123' })], [doc({})])).toHaveLength(1);
  });
  it('1 Ft eltérésnél nem párosít', () => {
    expect(matchPayments([tx({ partner: 'Orvosmost Kft', amount: 127001 })], [doc({})])).toHaveLength(0);
  });
  it('ismeretlen partner, nincs számlaszám → nem párosít', () => {
    expect(matchPayments([tx({ partner: 'Valaki Más Bt' })], [doc({})])).toHaveLength(0);
  });
  it('két azonos összegű számla ugyanattól a partnertől → kétes, nem párosít', () => {
    expect(matchPayments([tx({ partner: 'Orvosmost' })], [doc({}), doc({ id: 2, number: 'PM-2026-000200' })])).toHaveLength(0);
  });
  it('alternatív név a partnertörzsből', () => {
    const m = matchPayments([tx({ partner: 'OM Egészség Zrt' })], [doc({})], (n) => (/orvosmost/i.test(n) ? [n, 'OM Egészség'] : [n]));
    expect(m).toHaveLength(1);
  });
  it('kiadás és devizás tétel nem számít', () => {
    expect(matchPayments([tx({ partner: 'Orvosmost', amount: -127000 }), tx({ id: 't2', partner: 'Orvosmost', currency: 'EUR' })], [doc({})])).toHaveLength(0);
  });
});
