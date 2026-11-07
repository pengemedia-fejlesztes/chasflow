// Író végpontok: hitelesítés, saját fiók (jelszó, 2FA, munkamenetek), felhasználókezelés, CSRF, adat-verzió.
// A valódi backend (createTestApp) ellen; minden írást az adatbázisban (t.sql) is ellenőrzünk.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createTestApp, type TestApp } from '../helpers/app';
import { totpCode } from '../../src/server/app/auth';

let t: TestApp | undefined;
afterEach(() => {
  t?.close();
  t = undefined;
  vi.unstubAllGlobals();
});

const PW = 'Teszt-jelszo-12345';
const NEW_PW = 'Uj-Biztos-Jelszo-2026';
const user = (email: string) => t!.sql.prepare('SELECT * FROM users WHERE email = ?').get(email) as any;
const count = (table: string, where = '1=1', ...args: any[]) => (t!.sql.prepare(`SELECT count(*) AS n FROM ${table} WHERE ${where}`).get(...args) as any).n as number;
const auditActions = () => (t!.sql.prepare('SELECT action FROM audit_log ORDER BY id').all() as any[]).map((r) => r.action);

/** Külön munkamenet (süti) egy felhasználónak, a teszt-app saját sütijének érintése nélkül. */
async function session(email: string, password = PW, extra: Record<string, unknown> = {}) {
  const r = await t!.call('POST', '/api/auth/login', { email, password, ...extra }, { Cookie: '' });
  const cookie = (r.headers.get('Set-Cookie') || '').split(';')[0];
  return { r, cookie, get: (p: string) => t!.call('GET', p, undefined, { Cookie: cookie }), call: (m: string, p: string, b?: unknown) => t!.call(m, p, b ?? {}, { Cookie: cookie }) };
}
const now30 = () => Math.floor(Date.now() / 30000);

describe('kezdeti beállítás (POST /api/auth/setup)', () => {
  it('rossz kóddal / hibás adattal nem jön létre felhasználó; jó kóddal admin + munkamenet; utána le van zárva', async () => {
    t = await createTestApp({ login: false, env: { SETUP_TOKEN: 'helyi-beallito-kod' } as any });
    t.sql.exec('DELETE FROM users');
    const bad = await t.post('/api/auth/setup', { token: 'rossz', email: 'laci@minta.hu', password: PW });
    expect(bad.status).toBe(403);
    expect(bad.data.error).toMatch(/beállító kód/);
    expect((await t.post('/api/auth/setup', { token: 'helyi-beallito-kod', email: 'nem-email', password: PW })).status).toBe(400);
    const short = await t.post('/api/auth/setup', { token: 'helyi-beallito-kod', email: 'laci@minta.hu', password: 'rovid' });
    expect(short.status).toBe(400);
    expect(short.data.error).toMatch(/12 karakter/);
    expect(count('users')).toBe(0);
    expect(auditActions()).toEqual(['setup_failed']);

    const ok = await t.post('/api/auth/setup', { token: 'helyi-beallito-kod', email: ' Laci@Minta.hu ', name: 'Laci', password: PW });
    expect(ok.status).toBe(200);
    const u = user('laci@minta.hu');
    expect(u).toMatchObject({ role: 'admin', name: 'Laci', must_change_pw: 0, totp_enabled: 0 });
    expect(count('sessions', 'user_id = ?', u.id)).toBe(1);
    const cookie = (ok.headers.get('Set-Cookie') || '').split(';')[0];
    expect((await t.call('GET', '/api/auth/status', undefined, { Cookie: cookie })).data.me).toMatchObject({ email: 'laci@minta.hu', role: 'admin' });

    const again = await t.post('/api/auth/setup', { token: 'helyi-beallito-kod', email: 'masik@minta.hu', password: PW });
    expect(again.status).toBe(403);
    expect(count('users')).toBe(1);
  });

  it('SETUP_TOKEN nélkül nem hozható létre admin', async () => {
    t = await createTestApp({ login: false });
    t.sql.exec('DELETE FROM users');
    expect((await t.post('/api/auth/setup', { token: '', email: 'laci@minta.hu', password: PW })).status).toBe(403);
    expect(count('users')).toBe(0);
  });
});

describe('belépés / kilépés', () => {
  it('sikeres belépés: munkamenet + utolsó belépés; hibás jelszó: számláló nő, munkamenet nincs; kilépés törli a munkamenetet', async () => {
    t = await createTestApp({ login: false });
    const bad = await session('admin@teszt.hu', 'rossz-jelszo-123');
    expect(bad.r.status).toBe(401);
    expect(bad.r.data.error).toBe('Hibás e-mail cím vagy jelszó.');
    expect(user('admin@teszt.hu').failed_logins).toBe(1);
    expect(count('sessions')).toBe(0);

    const s = await session('ADMIN@teszt.hu');
    expect(s.r.status).toBe(200);
    const u = user('admin@teszt.hu');
    expect(u.failed_logins).toBe(0);
    expect(u.last_login).toBeGreaterThan(0);
    expect(count('sessions', 'user_id = ?', u.id)).toBe(1);
    expect((await s.get('/api/data')).status).toBe(200);

    const out = await s.call('POST', '/api/auth/logout');
    expect(out.status).toBe(200);
    expect(out.headers.get('Set-Cookie')).toMatch(/Max-Age=0/);
    expect(count('sessions')).toBe(0);
    expect((await s.get('/api/data')).status).toBe(401);
  });

  it('letiltott felhasználó nem léphet be (ugyanaz az üzenet, mint a hibás jelszónál)', async () => {
    t = await createTestApp({ login: false });
    await t.addUser('kilepett@minta.hu', 'member');
    t.sql.prepare("UPDATE users SET disabled = 1 WHERE email = 'kilepett@minta.hu'").run();
    const s = await session('kilepett@minta.hu');
    expect(s.r.status).toBe(401);
    expect(count('sessions')).toBe(0);
  });
});

describe('elfelejtett jelszó (POST /api/auth/forgot, /api/auth/reset)', () => {
  const mailEnv = { BREVO_API_KEY: 'teszt-brevo-kulcs', MAIL_FROM: 'Cashflow <noreply@minta.hu>' } as any;
  function mailbox() {
    const sent: any[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const req = new Request(input, init);
        if (!req.url.startsWith('https://api.brevo.com/')) throw new Error('váratlan külső hívás: ' + req.url);
        sent.push(await req.json());
        return new Response('{}', { status: 201 });
      }),
    );
    return sent;
  }
  const tokenOf = (mail: any) => /reset=([\w-]+)/.exec(mail.textContent)![1];

  it('a link egyszer használható: új jelszó, minden munkamenet kilép, a régi jelszó nem jó; ismeretlen címre nincs levél', async () => {
    const sent = mailbox();
    t = await createTestApp({ env: mailEnv });
    const unknown = await t.post('/api/auth/forgot', { email: 'nincs@minta.hu' });
    expect(unknown.status).toBe(200);
    expect(count('password_resets')).toBe(0);
    expect(sent).toHaveLength(0);

    const r = await t.post('/api/auth/forgot', { email: 'admin@teszt.hu' });
    expect(r.status).toBe(200);
    expect(r.data.message).toBe(unknown.data.message); // ugyanaz a válasz: nem deríthető ki, létezik-e a fiók
    expect(sent).toHaveLength(1);
    expect(sent[0].to).toEqual([{ email: 'admin@teszt.hu' }]);
    const token = tokenOf(sent[0]);
    expect(count('password_resets', 'used_at IS NULL')).toBe(1);
    expect((await t.post('/api/auth/reset-info', { token })).data).toMatchObject({ valid: true, email: 'admin@teszt.hu', needTotp: false });

    const short = await t.post('/api/auth/reset', { token, password: 'rovid' });
    expect(short.status).toBe(400);
    expect(count('password_resets', 'used_at IS NULL')).toBe(1); // a hibás próbálkozás nem „használja el” a linket

    const ok = await t.post('/api/auth/reset', { token, password: NEW_PW });
    expect(ok.status).toBe(200);
    expect(count('sessions')).toBe(0);
    expect(count('password_resets', 'used_at IS NULL')).toBe(0);
    expect(sent).toHaveLength(2); // értesítő a változásról
    expect((await t.get('/api/data')).status).toBe(401);
    expect((await session('admin@teszt.hu', PW)).r.status).toBe(401);
    expect((await session('admin@teszt.hu', NEW_PW)).r.status).toBe(200);

    const reuse = await t.post('/api/auth/reset', { token, password: 'Harmadik-Jelszo-2026' });
    expect(reuse.status).toBe(400);
    expect(reuse.data.error).toMatch(/lejárt vagy már felhasználták/);
  });

  it('bekapcsolt 2FA mellett a kód nélkül nem állítható vissza a jelszó', async () => {
    const sent = mailbox();
    t = await createTestApp({ env: mailEnv });
    t.sql.prepare("UPDATE users SET totp_enabled = 1, totp_secret = 'JBSWY3DPEHPK3PXP' WHERE email = 'admin@teszt.hu'").run();
    await t.post('/api/auth/forgot', { email: 'admin@teszt.hu' });
    const token = tokenOf(sent[0]);
    const before = user('admin@teszt.hu').pw_hash;
    const r = await t.post('/api/auth/reset', { token, password: NEW_PW, totp: '000000' });
    expect(r.status).toBe(400);
    expect(r.data.error).toMatch(/kétlépcsős/);
    expect(user('admin@teszt.hu').pw_hash).toBe(before);
    const ok = await t.post('/api/auth/reset', { token, password: NEW_PW, totp: await totpCode('JBSWY3DPEHPK3PXP', now30()) });
    expect(ok.status).toBe(200);
    expect(user('admin@teszt.hu').pw_hash).not.toBe(before);
  });

  it('e-mail küldés nélkül érthető 503, és nem jön létre visszaállító link', async () => {
    t = await createTestApp();
    const r = await t.post('/api/auth/forgot', { email: 'admin@teszt.hu' });
    expect(r.status).toBe(503);
    expect(r.data.error).toMatch(/adminisztrátort/);
    expect(count('password_resets')).toBe(0);
  });
});

describe('saját fiók (/api/account/*)', () => {
  it('jelszócsere: hibás jelenlegi / rövid új jelszó → 400 és nem változik; siker → a többi munkamenet kilép, ez marad', async () => {
    t = await createTestApp();
    const other = await session('admin@teszt.hu');
    const before = user('admin@teszt.hu').pw_hash;
    const wrong = await t.post('/api/account/password', { current: 'nem-ez-a-jelszo', next: NEW_PW });
    expect(wrong.status).toBe(400);
    expect(wrong.data.error).toBe('A jelenlegi jelszó hibás.');
    expect((await t.post('/api/account/password', { current: PW, next: 'rovid' })).status).toBe(400);
    expect(user('admin@teszt.hu').pw_hash).toBe(before);
    expect(count('sessions')).toBe(2);

    expect((await t.post('/api/account/password', { current: PW, next: NEW_PW })).status).toBe(200);
    expect(user('admin@teszt.hu').pw_hash).not.toBe(before);
    expect(count('sessions')).toBe(1);
    expect((await t.get('/api/data')).status).toBe(200);
    expect((await other.get('/api/data')).status).toBe(401);
    expect(auditActions()).toContain('password_changed');
  });

  it('ideiglenes jelszóval csak a jelszócsere megy; utána minden', async () => {
    t = await createTestApp();
    const created = await t.post('/api/users', { email: 'uj@minta.hu', name: 'Új Kolléga', role: 'member' });
    const s = await session('uj@minta.hu', created.data.tempPassword);
    expect(s.r.status).toBe(200);
    expect(s.r.data.me.must_change_pw).toBe(1);
    const blocked = await s.get('/api/data');
    expect(blocked.status).toBe(403);
    expect(blocked.data.error).toMatch(/ideiglenes jelszavadat/);
    expect((await s.call('POST', '/api/account/password', { current: created.data.tempPassword, next: NEW_PW })).status).toBe(200);
    expect(user('uj@minta.hu').must_change_pw).toBe(0);
    expect((await s.get('/api/data')).status).toBe(200);
  });

  it('2FA: beállítás → hibás kód nem kapcsolja be → jó kód bekapcsolja → belépéshez kell a kód; adminon nem kapcsolható ki', async () => {
    t = await createTestApp();
    const setup = await t.post('/api/account/totp/setup');
    expect(setup.status).toBe(200);
    expect(user('admin@teszt.hu')).toMatchObject({ totp_secret: setup.data.secret, totp_enabled: 0 });
    expect(setup.data.url).toContain('otpauth://totp/');

    const good = await totpCode(setup.data.secret, now30());
    const bad = await t.post('/api/account/totp/enable', { code: String((Number(good) + 500_000) % 1_000_000).padStart(6, '0') });
    expect(bad.status).toBe(400);
    expect(user('admin@teszt.hu').totp_enabled).toBe(0);
    expect((await t.post('/api/account/totp/enable', { code: await totpCode(setup.data.secret, now30()) })).status).toBe(200);
    expect(user('admin@teszt.hu').totp_enabled).toBe(1);
    expect((await t.post('/api/account/totp/setup')).status).toBe(400); // a titok nem cserélhető le csendben
    expect(user('admin@teszt.hu').totp_secret).toBe(setup.data.secret);

    const noCode = await session('admin@teszt.hu');
    expect(noCode.r.data).toEqual({ needTotp: true });
    expect(noCode.cookie).toBe('');
    const withCode = await session('admin@teszt.hu', PW, { totp: await totpCode(setup.data.secret, now30()) });
    expect(withCode.r.status).toBe(200);

    const off = await t.post('/api/account/totp/disable', { password: PW });
    expect(off.status).toBe(400);
    expect(user('admin@teszt.hu').totp_enabled).toBe(1);
  });

  it('2FA kikapcsolása (nem admin): csak a jelszóval, és a titok is törlődik', async () => {
    t = await createTestApp();
    await t.addUser('szerk@minta.hu', 'member');
    t.sql.prepare("UPDATE users SET totp_enabled = 1, totp_secret = 'JBSWY3DPEHPK3PXP' WHERE email = 'szerk@minta.hu'").run();
    const s = await session('szerk@minta.hu', PW, { totp: await totpCode('JBSWY3DPEHPK3PXP', now30()) });
    expect((await s.call('POST', '/api/account/totp/disable', { password: 'rossz-jelszo-99' })).status).toBe(400);
    expect(user('szerk@minta.hu').totp_enabled).toBe(1);
    expect((await s.call('POST', '/api/account/totp/disable', { password: PW })).status).toBe(200);
    expect(user('szerk@minta.hu')).toMatchObject({ totp_enabled: 0, totp_secret: null });
  });

  it('kilépés minden eszközön: a felhasználó összes munkamenete törlődik (másoké nem)', async () => {
    t = await createTestApp();
    await t.addUser('olvaso@minta.hu', 'viewer');
    const other = await session('admin@teszt.hu');
    const viewer = await session('olvaso@minta.hu');
    expect((await t.del('/api/account/sessions')).status).toBe(200);
    expect(count('sessions', 'user_id = ?', t.userId)).toBe(0);
    expect((await other.get('/api/data')).status).toBe(401);
    expect((await viewer.get('/api/data')).status).toBe(200);
    // az olvasó a saját fiókját kezelheti (jelszó), ez nem „adatírás”
    expect((await viewer.call('POST', '/api/account/password', { current: PW, next: NEW_PW })).status).toBe(200);
  });
});

describe('felhasználókezelés (/api/users, csak admin)', () => {
  it('meghívás: ideiglenes jelszó, kötelező csere; ismétlés 409; hibás cím / szerepkör 400 – sor nélkül', async () => {
    t = await createTestApp();
    const r = await t.post('/api/users', { email: ' Kolléga@Minta.hu ', name: 'Kolléga', role: 'viewer' });
    expect(r.status).toBe(200);
    expect(r.data.tempPassword).toMatch(/^[\w-]{16}$/);
    expect(user('kolléga@minta.hu')).toMatchObject({ name: 'Kolléga', role: 'viewer', must_change_pw: 1, disabled: 0 });
    const dup = await t.post('/api/users', { email: 'kolléga@minta.hu', role: 'member' });
    expect(dup.status).toBe(409);
    expect(dup.data.error).toMatch(/már van felhasználó/);
    expect((await t.post('/api/users', { email: 'nem-email', role: 'member' })).status).toBe(400);
    const badRole = await t.post('/api/users', { email: 'harmadik@minta.hu', role: 'superuser' });
    expect(badRole.status).toBe(400);
    expect(badRole.data.error).toMatch(/szerepkör/);
    expect(count('users')).toBe(2);
    // szerepkör nélkül: szerkesztő (ez a felület alapértéke)
    expect((await t.post('/api/users', { email: 'negyedik@minta.hu' })).status).toBe(200);
    expect(user('negyedik@minta.hu').role).toBe('member');
  });

  it('szerepkör, letiltás, jelszó-visszaállítás, törlés – és mindegyik munkamenet-hatása', async () => {
    t = await createTestApp();
    const id = await t.addUser('szerk@minta.hu', 'member');
    const s = await session('szerk@minta.hu');
    expect((await t.patch(`/api/users/${id}`, { role: 'viewer' })).status).toBe(200);
    expect(user('szerk@minta.hu').role).toBe('viewer');
    expect((await s.call('POST', '/api/leaves', { group_id: 'x', label: 'y' })).status).toBe(403);

    const badRole = await t.patch(`/api/users/${id}`, { role: 'editor' });
    expect(badRole.status).toBe(400);
    expect(user('szerk@minta.hu').role).toBe('viewer');

    expect((await t.patch(`/api/users/${id}`, { disabled: true })).status).toBe(200);
    expect(user('szerk@minta.hu').disabled).toBe(1);
    expect(count('sessions', 'user_id = ?', id)).toBe(0);
    expect((await s.get('/api/data')).status).toBe(401);
    expect((await t.patch(`/api/users/${id}`, { disabled: false })).status).toBe(200);
    expect(user('szerk@minta.hu').disabled).toBe(0);

    t.sql.prepare("UPDATE users SET totp_enabled = 1, totp_secret = 'JBSWY3DPEHPK3PXP', locked_until = ? WHERE id = ?").run(Date.now() + 60_000, id);
    const s2 = await session('szerk@minta.hu'); // zárolva → nincs munkamenet
    expect(s2.r.status).toBe(429);
    const reset = await t.post(`/api/users/${id}/reset`);
    expect(reset.status).toBe(200);
    expect(user('szerk@minta.hu')).toMatchObject({ must_change_pw: 1, totp_enabled: 0, totp_secret: null, locked_until: 0 });
    expect((await session('szerk@minta.hu', reset.data.tempPassword)).r.status).toBe(200);

    expect((await t.del(`/api/users/${id}`)).status).toBe(200);
    expect(user('szerk@minta.hu')).toBeUndefined();
    expect(count('sessions', 'user_id = ?', id)).toBe(0);
    expect(auditActions()).toEqual(expect.arrayContaining(['user_updated', 'user_reset', 'user_deleted']));
  });

  it('saját magát nem fokozhatja le, tilthatja le, törölheti; nem létező felhasználó 404', async () => {
    t = await createTestApp();
    for (const [m, b] of [
      ['PATCH', { role: 'member' }],
      ['PATCH', { disabled: true }],
      ['DELETE', undefined],
    ] as const) {
      const r = await t.call(m, `/api/users/${t.userId}`, b);
      expect(r.status).toBe(400);
    }
    expect(user('admin@teszt.hu')).toMatchObject({ role: 'admin', disabled: 0 });
    for (const [m, p] of [
      ['PATCH', '/api/users/999'],
      ['DELETE', '/api/users/999'],
      ['POST', '/api/users/999/reset'],
    ] as const) {
      const r = await t.call(m, p, { role: 'viewer' });
      expect([p, r.status]).toEqual([p, 404]);
      expect(r.data.error).toMatch(/Nincs ilyen felhasználó/);
    }
  });

  it('szerkesztő és olvasó: 403 minden felhasználó-végponton, semmi nem változik', async () => {
    t = await createTestApp();
    const vid = await t.addUser('olvaso@minta.hu', 'viewer');
    await t.addUser('szerk@minta.hu', 'member');
    for (const email of ['szerk@minta.hu', 'olvaso@minta.hu']) {
      const s = await session(email);
      for (const [m, p, b] of [
        ['POST', '/api/users', { email: 'x@minta.hu', role: 'admin' }],
        ['PATCH', `/api/users/${vid}`, { role: 'admin' }],
        ['POST', `/api/users/${vid}/reset`, {}],
        ['DELETE', `/api/users/${t.userId}`, {}],
      ] as const) {
        const r = await s.call(m, p, b);
        expect([email, p, r.status]).toEqual([email, p, 403]);
      }
    }
    expect(count('users')).toBe(3);
    expect(user('olvaso@minta.hu').role).toBe('viewer');
    expect(user('admin@teszt.hu').must_change_pw).toBe(0);
  });
});

describe('általános védelem minden író kérésen', () => {
  it('CSRF: idegen Origin vagy hiányzó X-Requested-With → 403, és nem ír', async () => {
    t = await createTestApp();
    t.sql.exec("INSERT INTO groups (id, section, label, sort) VALUES ('g_in', 'in', 'Projektek', 1)");
    const body = { group_id: 'g_in', label: 'Minta Kft.' };
    const foreign = await t.call('POST', '/api/leaves', body, { Origin: 'https://gonosz.example' });
    expect(foreign.status).toBe(403);
    expect(foreign.data.error).toBe('Tiltott eredet.');
    const noHeader = await t.call('POST', '/api/leaves', body, { 'X-Requested-With': '' });
    expect(noHeader.status).toBe(403);
    expect(noHeader.data.error).toBe('Hiányzó kliens fejléc.');
    // bejelentkezés sem kerülheti meg (login CSRF)
    expect((await t.call('POST', '/api/auth/login', { email: 'admin@teszt.hu', password: PW }, { Origin: 'https://gonosz.example' })).status).toBe(403);
    expect(count('leaves')).toBe(0);
    expect((await t.post('/api/leaves', body)).status).toBe(200);
    expect(count('leaves')).toBe(1);
  });

  it('sikeres írás után új adat-verzió (data_rev), hibás kérés után nem', async () => {
    t = await createTestApp();
    const rev = async () => (await t!.get('/api/version')).data.rev;
    t.sql.prepare("UPDATE settings SET value = '1000' WHERE key = 'data_rev'").run();
    expect((await t.post('/api/groups', { section: 'out', label: '' })).status).toBe(400);
    expect(await rev()).toBe('1000');
    expect((await t.post('/api/groups', { section: 'out', label: 'Működési költségek' })).status).toBe(200);
    expect(Number(await rev())).toBeGreaterThan(1000);
  });
});

describe('váratlan szerverhiba', () => {
  it('500: a válaszban nincs belső részlet, a hiba a diagnosztikai listába kerül (adat nélkül), új adat-verzió nincs', async () => {
    t = await createTestApp();
    t.sql.prepare("UPDATE settings SET value = '1000' WHERE key = 'data_rev'").run();
    t.sql.exec('DROP TABLE month_stats');
    const r = await t.post('/api/stats/refresh');
    expect(r.status).toBe(500);
    expect(r.data).toEqual({ error: 'Szerverhiba. Próbáld újra később.' });
    const errs = JSON.parse((t.sql.prepare("SELECT value FROM settings WHERE key = 'server_errors'").get() as any).value);
    expect(errs[0]).toMatchObject({ m: 'POST', p: '/api/stats/refresh' });
    expect(errs[0].e).toMatch(/month_stats/);
    expect((t.sql.prepare("SELECT value FROM settings WHERE key = 'data_rev'").get() as any).value).toBe('1000');
  });
});
