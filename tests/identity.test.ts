import { describe, expect, it } from 'vitest';
import { compactName, partnerResolver, suggestPartner } from '../shared/identity';
import type { Leaf, Partner } from '../shared/types';

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
