import { describe, expect, it } from 'vitest';
import { collectAggreg8, consentIds, jwtExpMs } from '../../src/shared/aggreg8export';

const jwt = (exp: number) => 'h.' + Buffer.from(JSON.stringify({ exp })).toString('base64url') + '.s';

describe('aggreg8 a szerverről', () => {
  it('JWT lejárat', () => {
    expect(jwtExpMs(jwt(1800000000))).toBe(1800000000 * 1000);
    expect(jwtExpMs('nem.jwt')).toBeNull();
  });
  it('lapozás a határnapig, számla az azonosítóból, egyenleg a bankkapcsolatból', async () => {
    const pages: Record<number, any> = {
      0: {
        data: [
          { _id: 'a', bookingDate: '2026-11-07', amount: 10, bankAccountId: 'acc1' },
          { _id: 'b', bookingDate: '2026-11-01', amount: -5, bankAccountId: 'acc1' },
        ],
        meta: { totalPages: 3 },
      },
      1: { data: [{ _id: 'c', bookingDate: '2026-10-20', amount: 7, bankAccountId: 'acc1' }], meta: { totalPages: 3 } },
      2: { data: [{ _id: 'd', bookingDate: '2026-09-01', amount: 1 }] },
    };
    const calls: string[] = [];
    const get = async (p: string) => {
      calls.push(p);
      if (p.startsWith('/transactions')) return pages[Number(p.split('=')[1])] ?? null;
      if (p === '/bank-access-consents')
        return [
          {
            _id: 'c1',
            bank: { name: 'MagNet' },
            consentedAccounts: [{ _id: 'acc1', accountNumber: 'HU12 1620 0000 0000 0000 0000 0001', balances: { bookedBalance: { amount: '1234' } } }],
          },
        ];
      return null;
    };
    const r = await collectAggreg8(get, '2026-10-25', async () => undefined);
    expect(calls.filter((c) => c.startsWith('/transactions'))).toEqual(['/transactions?page=0', '/transactions?page=1']);
    expect(r.transactions.map((t) => t._id)).toEqual(['a', 'b']);
    expect(r.transactions[0].account).toBe('HU12162000000000000000000001');
    expect(r.balances).toEqual({ HU12162000000000000000000001: 1234 });
    expect(await consentIds(get)).toEqual([{ id: 'c1', bank: 'MagNet', validUntil: null }]);
  });
});
