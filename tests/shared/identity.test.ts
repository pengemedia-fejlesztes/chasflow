import { describe, expect, it } from 'vitest';
import { compactName, partnerResolver, possibleDuplicate, suggestPartner } from '../../src/shared/identity';
import type { Leaf, Partner } from '../../src/shared/types';

const leaf = (id: string, label: string): Leaf => ({ id, group_id: 'g', label, archived: 0 }) as Leaf;
const partner = (key: string, name: string, aliases: string[], tax: string | null = null): Partner => ({
  key,
  name,
  kind: null,
  aliases,
  tax_number: tax,
  note: null,
  updated_at: 0,
});

describe('partner-azonosság', () => {
  const leaves = [leaf('l1', 'Pharmazone'), leaf('l2', 'Mr. Big'), leaf('l3', 'Autocom')];
  const r = partnerResolver(leaves, [partner('pharmazone', 'Pharmazone', ['Kalmia'], '12345678-2-13')]);

  it('jogi forma és írásjel nélkül egyezik', () => {
    expect(compactName('Mr. Big Kft.')).toBe('mrbig');
    expect(r.resolve('MrBIG Kft')?.key).toBe('mrbig');
  });
  it('alternatív név (pl. elszámolás projektneve) a partnerhez tartozik', () => {
    expect(r.resolve('Kalmia')?.key).toBe('pharmazone');
  });
  it('az adószám mindent megelőz', () => {
    expect(r.resolve('Teljesen Más Név Zrt.', '12345678-2-41')?.key).toBe('pharmazone');
  });
  it('a hosszabb cégnév is felismerhető', () => {
    expect(r.resolve('AUTOCOM Szolgáltató Kft.')?.key).toBe('autocom');
  });
  it('ismeretlen név: nincs találat, de javaslat lehet', () => {
    expect(r.resolve('Ismeretlen Bt.')).toBeNull();
    expect(suggestPartner(r, 'Pharmazon Gyógyszer')?.key).toBe('pharmazone');
  });
});

describe('lehetséges dupla import (possibleDuplicate)', () => {
  const act = (o: { id: string; date: string; amount: number; name: string; leaf_id: string; source?: string }) => ({ kind: 'actual' as const, source: 'import', ...o });
  const tx = { date: '2026-08-25', amount: -18225, partner: 'MINTA TÁRHELY KFT.', leaf_id: 'l_dom' };
  it('azonos nap, azonos partner (név vagy kategória), legfeljebb 1% eltérés', () => {
    expect(possibleDuplicate(tx, [act({ id: 'a', date: '2026-08-25', amount: -18255, name: 'Minta Tárhely', leaf_id: 'l_egyeb' })])?.id).toBe('a');
    expect(possibleDuplicate(tx, [act({ id: 'b', date: '2026-08-25', amount: -18100, name: 'Tárhely díj', leaf_id: 'l_dom' })])?.id).toBe('b');
  });
  it('nem dupla: más nap, 1%-nál nagyobb eltérés, más partner, banki vagy Billingo-tény, ellenkező előjel', () => {
    expect(
      possibleDuplicate(tx, [
        act({ id: 'nap', date: '2026-08-26', amount: -18225, name: 'Minta Tárhely', leaf_id: 'l_dom' }),
        act({ id: 'osszeg', date: '2026-08-25', amount: -18500, name: 'Minta Tárhely', leaf_id: 'l_dom' }),
        act({ id: 'partner', date: '2026-08-25', amount: -18225, name: 'Példa Szoftver Kft.', leaf_id: 'l_szoftver' }),
        act({ id: 'bank', date: '2026-08-25', amount: -18225, name: 'Minta Tárhely', leaf_id: 'l_dom', source: 'bank' }),
        act({ id: 'billingo', date: '2026-08-25', amount: -18225, name: 'Minta Tárhely', leaf_id: 'l_dom', source: 'billingo' }),
        act({ id: 'elojel', date: '2026-08-25', amount: 18225, name: 'Minta Tárhely', leaf_id: 'l_dom' }),
      ]),
    ).toBeNull();
  });
});
