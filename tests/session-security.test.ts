import { describe, expect, it } from 'vitest';
import { currentUser } from '../worker/auth';

describe('a régi munkamenetekre is érvényes lejárat', () => {
  const check = async (age: number, idle: number, expiresIn = 30 * 86400_000) => {
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
            first: async () => ({ id: 1, role: 'admin', session_created_at: t - age, last_seen: t - idle, expires_at: t + expiresIn, disabled: 0 }),
            run: async () => ({}),
          };
        },
      },
    } as any;
    const user = await currentUser(env, new Request('https://test.invalid', { headers: { Cookie: '__Host-cf_session=synthetic-session' } }));
    return { user, calls };
  };
  // Laci kérése (2026-11-08): ne léptessen ki – sem inaktivitás, sem 12 óra után; használatkor megújul
  it('napok inaktivitás után sem lép ki, és a használat megújítja a lejáratot', async () => {
    const r = await check(20 * 86400_000, 5 * 86400_000);
    expect(r.user).toMatchObject({ id: 1 });
    expect(r.calls.some((s) => s.includes('expires_at = ?'))).toBe(true);
  });
  it('a lejárt session nem él', async () => {
    const r = await check(3600_000, 0, -1000);
    expect(r.user).toBeNull();
    expect(r.calls.some((s) => s.startsWith('DELETE FROM sessions'))).toBe(true);
  });
});
