import { describe, expect, it } from 'vitest';
import { dayNameHu, firstWorkday, isWorkday, lastWorkday, payDate } from '../shared/workdays';

describe('munkarend-naptár 2024–2027', () => {
  it('áthelyezett pihenőnap és ledolgozós szombat', () => {
    expect(isWorkday('2026-01-02')).toBe(false); // péntek, áthelyezett pihenőnap
    expect(isWorkday('2026-01-10')).toBe(true); // szombat, ledolgozós
    expect(isWorkday('2026-08-21')).toBe(false);
    expect(isWorkday('2026-08-08')).toBe(true);
    expect(isWorkday('2026-12-24')).toBe(false);
    expect(isWorkday('2026-12-12')).toBe(true);
    expect(isWorkday('2025-05-02')).toBe(false);
    expect(isWorkday('2025-12-13')).toBe(true);
  });
  it('december 24. nem törvényes ünnep (2027-ben péntek, munkanap amíg nincs rendelet)', () => {
    expect(isWorkday('2027-12-24')).toBe(true);
    expect(isWorkday('2027-12-27')).toBe(true);
    expect(isWorkday('2027-03-26')).toBe(false); // nagypéntek
  });
  it('első / utolsó munkanap, hónap eleje / vége', () => {
    expect(firstWorkday('2026-01')).toBe('2026-01-05'); // jan. 1. ünnep, 2. pihenőnap, 3–4. hétvége
    expect(lastWorkday('2026-12')).toBe('2026-12-31');
    expect(lastWorkday('2026-10')).toBe('2026-10-30');
    expect(payDate('2026-11', 'month_start', 1)).toBe('2026-11-01');
    expect(payDate('2026-11', 'month_end', 1)).toBe('2026-11-30');
    expect(dayNameHu('2026-11-30')).toBe('hétfő');
    expect(dayNameHu('2026-12-24', true)).toBe('csütörtök (munkaszüneti nap)');
    expect(dayNameHu('2026-12-12', true)).toBe('szombat (munkanap)');
  });
});
