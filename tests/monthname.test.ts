import { describe, expect, it } from 'vitest';
import { baseName, hasMonth, withMonth } from '../shared/monthname';

describe('havidíj név a hónappal', () => {
  it('a hónap a név végére kerül, csak havidíjnál', () => {
    expect(withMonth('Havi díj', '2026-10')).toBe('Havi díj – 2026. október');
    expect(withMonth('Havidíj', '2026-11')).toBe('Havidíj – 2026. november');
    expect(withMonth('Weboldal fejlesztés', '2026-10')).toBe('Weboldal fejlesztés');
  });
  it('ha már benne van a hónap (kézzel átírva is), nem duplázza', () => {
    expect(withMonth('Havi díj – 2026. október', '2026-11')).toBe('Havi díj – 2026. október');
    expect(withMonth('Havidíj október', '2026-11')).toBe('Havidíj október');
    expect(hasMonth('Havi díj - december')).toBe(true);
  });
  it('csoportosítás az alapnév szerint', () => {
    expect(baseName('Havi díj – 2026. október')).toBe('Havi díj');
    expect(baseName('Havidíj november')).toBe('Havidíj');
    expect(baseName('Havi díj')).toBe('Havi díj');
  });
});

describe('minden ismétlődő tétel a hónappal', () => {
  it('munkabér sorozatban: a hónap a névbe kerül; egyszeri tétel nem', () => {
    expect(withMonth('Munkabér', '2026-10', true)).toBe('Munkabér – 2026. október');
    expect(withMonth('Munkabér', '2026-10')).toBe('Munkabér');
    expect(withMonth('ÁFA – 2026. október', '2026-11', true)).toBe('ÁFA – 2026. október');
  });
});
