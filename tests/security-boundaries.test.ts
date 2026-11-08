import { beforeEach, describe, expect, it, vi } from 'vitest';
import { FULL_ACCESS, NO_ACCESS, type Access } from '../shared/access';
import { visibleBundle } from '../worker/visibility';
import { currentUser } from '../worker/auth';
import { twofaMode } from '../worker/access';
import { enforceHttps } from '../worker/util';
import worker from '../worker/index';

vi.mock('../worker/auth', async (original) => ({ ...(await original<any>()), currentUser: vi.fn(), handleAuth: vi.fn(async () => null) }));

const fixture = (role = 'member') =>
  ({
    me: { id: 2, role },
    settings: {
      opening_balance: '100',
      profit_target: '200',
      default_pay_days: '8',
      import_token: 'SECRET_MARKER',
      user_access: 'SECRET_MARKER',
      task_perms: 'SECRET_MARKER',
      bank_last_dates: 'SECRET_MARKER',
      a8_server_status: 'SECRET_MARKER',
      future_secret: 'SECRET_MARKER',
      billingo_autopay_last: 'SECRET_MARKER',
      server_errors: 'SECRET_MARKER',
    },
    ...Object.fromEntries(
      [
        'groups',
        'leaves',
        'entries',
        'series',
        'deleted',
        'lostOffers',
        'monthStats',
        'partnerNames',
        'accounts',
        'bankTx',
        'employees',
        'worktime',
        'billingo',
        'navInvoices',
        'partners',
        'partnerProducts',
        'products',
        'warehouses',
        'stockLevels',
        'stockMoves',
        'tasks',
        'taskUsers',
      ].map((k) => [k, [{ id: 'sensitive-row', amount: 123456, name: 'salary' }]]),
    ),
    partnerProfiles: { partner: { company: 'Test', bank_account: 'BANK_MARKER' } },
  }) as any;

describe('adatcsomag: adatkörök és másodlagos adatutak', () => {
  it('a nulla engedélyes tag nem kap főkönyvet, kukát, profilt vagy belső beállítást', () => {
    const b = visibleBundle(fixture(), NO_ACCESS);
    expect(JSON.stringify(b)).not.toMatch(/SECRET_MARKER|BANK_MARKER|sensitive-row|123456/);
    expect(b.settings).toEqual({});
    expect(b.myAccess?.menus).toEqual([]);
  });
  it.each(['bank', 'payroll', 'invoices'] as const)('a %s tiltását összesített és törölt adatok sem kerülhetik meg', (scope) => {
    const a: Access = { ...FULL_ACCESS, data: { ...FULL_ACCESS.data, [scope]: false } };
    const b = visibleBundle(fixture(), a);
    for (const k of ['entries', 'series', 'deleted', 'lostOffers', 'monthStats', 'partnerNames']) expect((b as any)[k]).toEqual([]);
    expect(b.settings).toEqual({});
    expect(b.myAccess?.menus).not.toContain('income');
    expect(b.myAccess?.menus).not.toContain('charts');
  });
  it('a Grafikonok önálló menüje csak teljes pénzügyi adatkörrel kap főkönyvet', () => {
    const access = { menus: ['charts'], data: { ...FULL_ACCESS.data } };
    const granted = visibleBundle(fixture(), access);
    expect(granted.entries).toHaveLength(1);
    expect(granted.myAccess?.menus).toEqual(['charts']);
    for (const scope of ['bank', 'payroll', 'invoices'] as const) {
      const denied = visibleBundle(fixture(), { ...access, data: { ...access.data, [scope]: false } });
      expect(denied.entries).toEqual([]);
      expect(denied.myAccess?.menus).not.toContain('charts');
    }
  });
  it('teljes engedélynél megmarad a főkönyv, de a belső settings nem kerül ki', () => {
    const original = fixture();
    const b = visibleBundle(original, FULL_ACCESS);
    expect(b.entries).toHaveLength(1);
    expect(b.settings).toEqual({ opening_balance: '100', profit_target: '200', default_pay_days: '8' });
    expect(original.settings.import_token).toBe('SECRET_MARKER');
  });
  it('a banktiltás a partnerprofil bankszámlaszámára is érvényes', () => {
    const b = visibleBundle(fixture(), { ...FULL_ACCESS, data: { ...FULL_ACCESS.data, bank: false } });
    expect(b.partnerProfiles?.partner.bank_account).toBe('');
  });
  it('admin sem kap tokent vagy jogosultságtáblát a settings mezőben', () => {
    const b = visibleBundle(fixture('admin'), FULL_ACCESS);
    expect(b.settings).not.toHaveProperty('import_token');
    expect(b.settings).not.toHaveProperty('user_access');
    expect(b.settings).not.toHaveProperty('future_secret');
    expect(b.settings).toHaveProperty('server_errors');
  });
});

describe('HTTP router: tényleges tiltás a kezelő előtt', () => {
  beforeEach(() => vi.mocked(currentUser).mockResolvedValue({ id: 2, role: 'member', totp_enabled: 0, must_change_pw: 0 } as any));
  const env = () =>
    ({
      DB: {
        prepare: vi.fn(() => ({
          bind(key: string) {
            return { first: async () => ({ value: key === 'user_access' ? JSON.stringify({ '2': NO_ACCESS }) : 'off' }) };
          },
        })),
      },
    }) as any;
  it.each([
    ['POST', '/api/entries/batch'],
    ['PATCH', '/api/groups/g'],
    ['POST', '/api/leaves/l/merge'],
    ['PUT', '/api/partners/p'],
    ['GET', '/api/trash'],
    ['POST', '/api/trash/restore'],
    ['GET', '/api/changelog'],
    ['POST', '/api/changelog/1/undo'],
    ['GET', '/api/series'],
  ])('%s %s → 403', async (method, path) => {
    const e = env();
    const r = await worker.fetch(new Request('https://test.invalid' + path, { method, headers: { 'X-Requested-With': 'cashflow' } }), e);
    expect(r.status).toBe(403);
    expect(e.DB.prepare.mock.calls.every(([sql]: string[]) => sql.startsWith('SELECT'))).toBe(true);
  });
  it('hibás jogosultság-beállítás mellett is tilt', async () => {
    const e = { DB: { prepare: () => ({ bind: () => ({ first: async () => ({ value: '{broken' }) }) }) } } as any;
    const r = await worker.fetch(new Request('https://test.invalid/api/trash'), e);
    expect(r.status).toBe(403);
  });
  it('a kétlépcsős azonosítás ki van kapcsolva (Laci kérése, 2026-11-08)', async () => {
    expect(await twofaMode(env())).toBe('off');
  });
});

describe('HTTPS-kényszerítés', () => {
  it('a GET megőrzi az útvonalat és a queryt, a módosítást elutasítja', () => {
    const r = enforceHttps(new Request('http://pmdev.hu/Cashflow/?a=1'))!;
    expect(r.status).toBe(308);
    expect(r.headers.get('Location')).toBe('https://pmdev.hu/Cashflow/?a=1');
    expect(enforceHttps(new Request('http://pmdev.hu/api/auth/login', { method: 'POST' }))?.status).toBe(403);
    expect(enforceHttps(new Request('http://127.0.0.1:8787/api/data'))).toBeNull();
  });
  it('HTTP-kérés nem érheti el sem az auth-, sem az adatkezelőt', async () => {
    const r = await worker.fetch(new Request('http://pmdev.hu/api/auth/login', { method: 'POST' }), {} as any);
    expect(r.status).toBe(403);
  });
});
