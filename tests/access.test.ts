import { describe, expect, it } from 'vitest';
import { FULL_ACCESS, INVITE_ACCESS, NO_ACCESS, accessOf, allowed, cleanAccess, needs2fa } from '../shared/access';

describe('hozzáférés: menüpontok és adatkörök', () => {
  it('admin mindent; hiányzó engedély tiltás; meghívott adatkörön kívül nem fér a főkönyvhöz', () => {
    expect(accessOf({ id: 1, role: 'admin' }, { '1': INVITE_ACCESS })).toEqual(FULL_ACCESS);
    expect(accessOf({ id: 2, role: 'member' }, {})).toEqual(NO_ACCESS);
    const a = accessOf({ id: 3, role: 'member' }, { '3': INVITE_ACCESS });
    expect(allowed('/api/bank/approve', a)).toBe(false);
    expect(allowed('/api/settings', a)).toBe(false);
    expect(allowed('/api/worktime/fetch', a)).toBe(false);
    expect(allowed('/api/tasks', a)).toBe(true);
    expect(allowed('/api/entries/batch', a)).toBe(false);
    expect(allowed('/api/sync', a)).toBe(false);
  });
  it('tisztítás: kizárólag kifejezett true ad engedélyt', () => {
    expect(cleanAccess({ menus: ['tasks', 'hack'], data: { bank: false } })).toEqual({
      menus: ['tasks'],
      data: { bank: false, payroll: false, invoices: false },
    });
  });
  it('ismeretlen és pénzügyi végpontok nem örökölnek engedélyt', () => {
    for (const path of [
      '/api/entries/batch',
      '/api/groups/g',
      '/api/leaves/l/merge',
      '/api/partners/p',
      '/api/trash/restore',
      '/api/changelog/1/undo',
      '/api/future',
    ])
      expect(allowed(path, NO_ACCESS)).toBe(false);
    expect(allowed('/api/data', NO_ACCESS)).toBe(true);
    expect(cleanAccess(null)).toEqual(NO_ACCESS);
    expect(cleanAccess({ data: { bank: 'true', payroll: 1, invoices: true } }).data).toEqual({ bank: false, payroll: false, invoices: true });
  });
  it('kötelező 2FA', () => {
    expect([needs2fa('admin', 'admin'), needs2fa('admin', 'member'), needs2fa('all', 'viewer'), needs2fa('off', 'admin')]).toEqual([true, false, true, false]);
  });
});
