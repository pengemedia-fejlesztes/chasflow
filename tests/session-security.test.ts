import { describe, expect, it } from 'vitest';
import { currentUser } from '../worker/auth';

describe('a régi munkamenetekre is érvényes lejárat', () => {
  const check = async (age: number, idle: number) => {
    const calls: string[] = [];
    const t = Date.now();
    const env = {
      DB: {
        prepare(sql: string) {
          calls.push(sql);
          return {
            bind() {
              return this;
            },
            first: async () => ({ id: 1, role: 'admin', session_created_at: t - age, last_seen: t - idle, expires_at: t + 30 * 86400_000, disabled: 0 }),
            run: async () => ({}),
          };
        },
      },
    } as any;
    const user = await currentUser(env, new Request('https://test.invalid', { headers: { Cookie: '__Host-cf_session=synthetic-session' } }));
    return { user, calls };
  };
  it('a régi, 30 napra kiadott session sem élhet 12 óránál tovább', async () => {
    const r = await check(13 * 3600_000, 0);
    expect(r.user).toBeNull();
    expect(r.calls.some((s) => s.startsWith('DELETE FROM sessions'))).toBe(true);
  });
  it('30 perc API-inaktivitás után lejár, a friss session működik', async () => {
    expect((await check(3600_000, 31 * 60_000)).user).toBeNull();
    expect((await check(3600_000, 0)).user).toMatchObject({ id: 1 });
  });
});
