import { describe, expect, it } from 'vitest';
import { FULL_ACCESS, INVITE_ACCESS, accessOf, allowed, cleanAccess, needs2fa } from '../shared/access';

describe('hozzáférés: menüpontok és adatkörök', () => {
  it('admin mindent; beállítás nélküli tag mindent (régi működés); meghívott alapból bank és beállítások nélkül', () => {
    expect(accessOf({ id: 1, role: 'admin' }, { '1': INVITE_ACCESS })).toEqual(FULL_ACCESS);
    expect(accessOf({ id: 2, role: 'member' }, {})).toEqual(FULL_ACCESS);
    const a = accessOf({ id: 3, role: 'member' }, { '3': INVITE_ACCESS });
    expect(allowed('/api/bank/approve', a)).toBe(false);
    expect(allowed('/api/settings', a)).toBe(false);
    expect(allowed('/api/worktime/fetch', a)).toBe(false);
    expect(allowed('/api/tasks', a)).toBe(true);
    expect(allowed('/api/entries/batch', a)).toBe(true);
    expect(allowed('/api/sync', a)).toBe(true); // a Tervezett bevételek oldalról is indítható
  });
  it('tisztítás: ismeretlen menü kimarad, az adatkör alapból engedélyezett', () => {
    expect(cleanAccess({ menus: ['tasks', 'hack'], data: { bank: false } })).toEqual({
      menus: ['tasks'],
      data: { bank: false, payroll: true, invoices: true },
    });
  });
  it('kötelező 2FA', () => {
    expect([needs2fa('admin', 'admin'), needs2fa('admin', 'member'), needs2fa('all', 'viewer'), needs2fa('off', 'admin')]).toEqual([true, false, true, false]);
  });
});
