// Terv / tény neve → kié (a számla partneréé, másik ügyfélé vagy általános) – a több ügyfeles alkategóriák
// (pl. „Domain és tárhely”) számla ↔ terv kötéséhez.
import { describe, expect, it } from 'vitest';
import { nameHead, nameOwner } from '../../src/shared/billingopay';

const known = ['Alfa Tanácsadó Kft.', 'ALFA', 'Béta Ingatlanfejlesztő Kft.', 'GammaHomes', 'Delta-Kert', 'Minta', 'Domain és tárhely'];
const alfa = ['Alfa Tanácsadó Kft.', 'ALFA'];

describe('nameHead', () => {
  it('a hónap / szolgáltatás / számlaszám rész nélkül', () => {
    expect(nameHead('GammaHomes – 2026. október')).toBe('GammaHomes');
    expect(nameHead('Delta Kert - Domain és tárhely – 2026. november')).toBe('Delta Kert');
    expect(nameHead('Alfa Tanácsadó Kft. · ALF-2026-000057')).toBe('Alfa Tanácsadó Kft.');
    expect(nameHead('Havi díj')).toBe('Havi díj');
  });
});

describe('nameOwner', () => {
  it('másik ügyfél nevére szóló terv (rövidítve, ékezet / kötőjel nélkül is)', () => {
    expect(nameOwner('GammaHomes – 2026. október', alfa, known, 'Domain és tárhely')).toBe('other');
    expect(nameOwner('Betaingatlan – 2026. október', alfa, known, 'Domain és tárhely')).toBe('other');
    expect(nameOwner('Delta Kert - Domain és tárhely – 2026. november', alfa, known, 'Domain és tárhely')).toBe('other');
  });
  it('a partner saját neve, álneve vagy rövidítése', () => {
    expect(nameOwner('Alfa – tárhely – 2026. november', alfa, known, 'Domain és tárhely')).toBe('own');
    expect(nameOwner('ALFA – alfa.hu domain és tárhely – 2027. február', alfa, known, 'Domain és tárhely')).toBe('own');
    expect(nameOwner('Alfa Tanácsadó Kft. · ALF-2026-000057', alfa, known, 'Domain és tárhely')).toBe('own');
  });
  it('általános név és a kategória neve: nem zárja ki', () => {
    expect(nameOwner('Havi díj – 2026. november', alfa, known, 'Minta')).toBe('neutral');
    expect(nameOwner('Marketing tanácsadás – 2026. november', alfa, known, 'Minta')).toBe('neutral');
    expect(nameOwner('Domain és tárhely – 2026. november', alfa, known, 'Domain és tárhely')).toBe('neutral');
    expect(nameOwner('Minta – 2026. november', ['Minta Kft.'], known, 'Minta')).toBe('own');
    expect(nameOwner('', alfa, known)).toBe('neutral');
  });
});
