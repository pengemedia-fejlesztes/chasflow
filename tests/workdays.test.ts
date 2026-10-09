import { describe, expect, it } from 'vitest';
import { addMonthsDate, firstWorkday, holidays, isWorkday, lastWorkday, mondayAfter, mondayOnOrAfter, payDate } from '../shared/workdays';

describe('munkanapok', () => {
  it('ünnepek 2026', () => {
    const h = holidays(2026);
    expect(h.has('2026-04-03')).toBe(true); // nagypéntek
    expect(h.has('2026-04-06')).toBe(true); // húsvéthétfő
    expect(h.has('2026-05-25')).toBe(true); // pünkösdhétfő
    expect(isWorkday('2026-10-23')).toBe(false);
  });
  it('első / utolsó munkanap', () => {
    expect(firstWorkday('2026-11')).toBe('2026-11-02'); // nov. 1. vasárnap + ünnep
    expect(firstWorkday('2027-01')).toBe('2027-01-04'); // jan. 1. péntek ünnep, 2-3 hétvége
    expect(lastWorkday('2026-10')).toBe('2026-10-30'); // okt. 31. szombat
    expect(lastWorkday('2026-12')).toBe('2026-12-31');
  });
  it('N. napig (hétvégén előtte)', () => {
    expect(payDate('2026-10', 'day:10', 1)).toBe('2026-10-09'); // okt. 10. szombat
    expect(payDate('2026-11', 'day:10', 1)).toBe('2026-11-10');
    expect(payDate('2026-11', null, 15)).toBe('2026-11-15');
  });
});

describe('gyors átütemezés hétfőre', () => {
  it('jövő hét hétfő / +2 hét / +1 hónap', () => {
    expect(mondayAfter('2026-10-09', 1)).toBe('2026-10-12'); // péntek → jövő hétfő
    expect(mondayAfter('2026-10-11', 1)).toBe('2026-10-12'); // vasárnap → másnap hétfő
    expect(mondayAfter('2026-10-12', 1)).toBe('2026-10-19'); // hétfő → egy héttel később
    expect(mondayAfter('2026-10-09', 2)).toBe('2026-10-19');
    expect(mondayOnOrAfter(addMonthsDate('2026-10-09', 1))).toBe('2026-11-09');
    expect(mondayOnOrAfter(addMonthsDate('2026-10-25', 1))).toBe('2026-11-30');
    expect(addMonthsDate('2027-01-31', 1)).toBe('2027-02-28');
  });
});
