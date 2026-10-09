// Hitelesítés: jelszó (PBKDF2), munkamenet süti, opcionális TOTP 2FA, brute-force védelem.
import type { Me, Role } from '../shared/types';
import { changedMail, mailEnabled, resetMail, sendMail } from './mail';
import { Env, HttpError, audit, b64decode, b64url, clientIp, json, now, randomBytes, readJson, safeEqual, sha256 } from './util';

const COOKIE = '__Host-cf_session';
const SESSION_TTL = 30 * 86400_000; // abszolút lejárat
const IDLE_TTL = 7 * 86400_000; // inaktivitás után kilép
const PBKDF2_ITER = 100_000; // a Workers futtatókörnyezet maximuma
const MAX_IP_ATTEMPTS = 20; // 15 percen belül
const MAX_USER_FAILS = 5;
const LOCK_MS = 15 * 60_000;

export interface User extends Me {
  pw_hash: string;
  pw_salt: string;
  pw_iter: number;
  totp_secret: string | null;
  failed_logins: number;
  locked_until: number;
  disabled: number;
}

export async function hashPassword(password: string, salt: Uint8Array<ArrayBuffer>, iter = PBKDF2_ITER): Promise<string> {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: iter }, key, 256);
  return b64url(bits);
}

export function validatePassword(pw: string) {
  if (typeof pw !== 'string' || pw.length < 12) throw new HttpError(400, 'A jelszó legalább 12 karakter legyen.');
  if (pw.length > 200) throw new HttpError(400, 'Túl hosszú jelszó.');
}

export async function newPasswordFields(pw: string) {
  validatePassword(pw);
  const salt = randomBytes(16);
  return { pw_hash: await hashPassword(pw, salt), pw_salt: b64url(salt), pw_iter: PBKDF2_ITER };
}

async function verifyPassword(u: User, pw: string): Promise<boolean> {
  const h = await hashPassword(pw, b64decode(u.pw_salt), u.pw_iter);
  return safeEqual(h, u.pw_hash);
}

// ---------- TOTP (RFC 6238) ----------
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
export function base32Encode(bytes: Uint8Array): string {
  let bits = 0,
    value = 0,
    out = '';
  for (const b of bytes) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}
function base32Decode(s: string): Uint8Array<ArrayBuffer> {
  const clean = s.replace(/=+$/, '').toUpperCase();
  let bits = 0,
    value = 0;
  const out: number[] = [];
  for (const c of clean) {
    const i = B32.indexOf(c);
    if (i < 0) continue;
    value = (value << 5) | i;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return new Uint8Array(out);
}
export async function totpCode(secret: string, counter: number): Promise<string> {
  const key = await crypto.subtle.importKey('raw', base32Decode(secret), { name: 'HMAC', hash: 'SHA-1' }, false, ['sign']);
  const msg = new Uint8Array(8);
  let c = counter;
  for (let i = 7; i >= 0; i--) {
    msg[i] = c & 255;
    c = Math.floor(c / 256);
  }
  const h = new Uint8Array(await crypto.subtle.sign('HMAC', key, msg));
  const off = h[h.length - 1] & 15;
  const bin = ((h[off] & 127) << 24) | (h[off + 1] << 16) | (h[off + 2] << 8) | h[off + 3];
  return String(bin % 1_000_000).padStart(6, '0');
}
export async function verifyTotp(secret: string, code: string): Promise<boolean> {
  const c = String(code || '').replace(/\s/g, '');
  if (!/^\d{6}$/.test(c)) return false;
  const t = Math.floor(Date.now() / 30000);
  for (const d of [-1, 0, 1]) if (safeEqual(await totpCode(secret, t + d), c)) return true;
  return false;
}

// ---------- munkamenet ----------
function getCookie(req: Request, name: string): string | null {
  const h = req.headers.get('Cookie') || '';
  for (const part of h.split(/;\s*/)) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i) === name) return part.slice(i + 1);
  }
  return null;
}

function sessionCookie(token: string, maxAgeSec: number) {
  return `${COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAgeSec}`;
}

async function createSession(env: Env, req: Request, userId: number): Promise<string> {
  const token = b64url(randomBytes(32));
  const t = now();
  await env.DB.prepare('INSERT INTO sessions (token_hash, user_id, created_at, expires_at, last_seen, ip, user_agent) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .bind(await sha256(token), userId, t, t + SESSION_TTL, t, clientIp(req), (req.headers.get('User-Agent') || '').slice(0, 200))
    .run();
  return token;
}

export async function currentUser(env: Env, req: Request): Promise<User | null> {
  const token = getCookie(req, COOKIE);
  if (!token || token.length > 100) return null;
  const th = await sha256(token);
  const row = await env.DB.prepare(`SELECT s.expires_at, s.last_seen, u.* FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ?`)
    .bind(th)
    .first<User & { expires_at: number; last_seen: number }>();
  if (!row) return null;
  const t = now();
  if (row.expires_at < t || row.last_seen + IDLE_TTL < t || row.disabled) {
    await env.DB.prepare('DELETE FROM sessions WHERE token_hash = ?').bind(th).run();
    return null;
  }
  if (t - row.last_seen > 60_000) await env.DB.prepare('UPDATE sessions SET last_seen = ? WHERE token_hash = ?').bind(t, th).run();
  return row;
}

export function publicUser(u: User): Me {
  return { id: u.id, email: u.email, name: u.name, role: u.role, totp_enabled: u.totp_enabled, must_change_pw: u.must_change_pw };
}

export function requireRole(u: User, ...roles: Role[]) {
  if (!roles.includes(u.role)) throw new HttpError(403, 'Nincs jogosultságod ehhez a művelethez.');
}

async function validResetToken(env: Env, token: string): Promise<{ user: User } | null> {
  if (!token || token.length > 100) return null;
  const row = await env.DB.prepare('SELECT r.expires_at, r.used_at, u.* FROM password_resets r JOIN users u ON u.id = r.user_id WHERE r.token_hash = ?')
    .bind(await sha256(token))
    .first<User & { expires_at: number; used_at: number | null }>();
  if (!row || row.used_at || row.expires_at < now() || row.disabled) return null;
  return { user: row };
}

// ---------- végpontok ----------
export async function handleAuth(env: Env, req: Request, path: string): Promise<Response | null> {
  if (path === '/api/auth/status' && req.method === 'GET') {
    const c = await env.DB.prepare('SELECT COUNT(*) AS n FROM users').first<{ n: number }>();
    const u = await currentUser(env, req);
    return json({ hasUsers: (c?.n || 0) > 0, setupAvailable: !c?.n && !!env.SETUP_TOKEN, mailEnabled: mailEnabled(env), me: u ? publicUser(u) : null });
  }

  if (path === '/api/auth/setup' && req.method === 'POST') {
    const body = await readJson(req);
    const c = await env.DB.prepare('SELECT COUNT(*) AS n FROM users').first<{ n: number }>();
    if ((c?.n || 0) > 0 || !env.SETUP_TOKEN) throw new HttpError(403, 'A kezdeti beállítás már megtörtént.');
    if (!safeEqual(String(body.token || ''), env.SETUP_TOKEN)) {
      await audit(env, null, 'setup_failed', { ip: clientIp(req) });
      throw new HttpError(403, 'Hibás beállító kód.');
    }
    const email = String(body.email || '')
      .trim()
      .toLowerCase();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new HttpError(400, 'Érvénytelen e-mail cím.');
    const pw = await newPasswordFields(String(body.password || ''));
    const r = await env.DB.prepare('INSERT INTO users (email, name, role, pw_hash, pw_salt, pw_iter, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .bind(email, String(body.name || email).slice(0, 80), 'admin', pw.pw_hash, pw.pw_salt, pw.pw_iter, now())
      .run();
    const id = Number(r.meta.last_row_id);
    await audit(env, id, 'setup_admin', { email });
    const token = await createSession(env, req, id);
    return json({ ok: true }, 200, { 'Set-Cookie': sessionCookie(token, SESSION_TTL / 1000) });
  }

  if (path === '/api/auth/login' && req.method === 'POST') {
    const ip = clientIp(req);
    const t = now();
    await env.DB.prepare('DELETE FROM login_attempts WHERE ts < ?')
      .bind(t - 86400_000)
      .run();
    const cnt = await env.DB.prepare('SELECT COUNT(*) AS n FROM login_attempts WHERE ip = ? AND ts > ?')
      .bind(ip, t - 15 * 60_000)
      .first<{ n: number }>();
    if ((cnt?.n || 0) >= MAX_IP_ATTEMPTS) throw new HttpError(429, 'Túl sok próbálkozás. Próbáld újra 15 perc múlva.');
    const body = await readJson(req);
    const email = String(body.email || '')
      .trim()
      .toLowerCase();
    const u = await env.DB.prepare('SELECT * FROM users WHERE email = ?').bind(email).first<User>();
    const fail = async (msg = 'Hibás e-mail cím vagy jelszó.') => {
      await env.DB.prepare('INSERT INTO login_attempts (ip, ts) VALUES (?, ?)').bind(ip, t).run();
      if (u) {
        const fails = u.failed_logins + 1;
        await env.DB.prepare('UPDATE users SET failed_logins = ?, locked_until = ? WHERE id = ?')
          .bind(fails >= MAX_USER_FAILS ? 0 : fails, fails >= MAX_USER_FAILS ? t + LOCK_MS : u.locked_until, u.id)
          .run();
        await audit(env, u.id, 'login_failed', { ip });
      }
      throw new HttpError(401, msg);
    };
    if (!u) {
      // időzítés kiegyenlítése, hogy ne lehessen e-mail címeket kitalálni
      await hashPassword(String(body.password || ''), randomBytes(16));
      return fail();
    }
    if (u.disabled) return fail();
    if (u.locked_until > t) throw new HttpError(429, 'A fiók átmenetileg zárolva a sok hibás próbálkozás miatt. Próbáld újra 15 perc múlva.');
    if (!(await verifyPassword(u, String(body.password || '')))) return fail();
    if (u.totp_enabled) {
      if (!body.totp) return json({ needTotp: true });
      if (!(await verifyTotp(u.totp_secret || '', String(body.totp)))) return fail('Hibás kétlépcsős kód.');
    }
    await env.DB.prepare('UPDATE users SET failed_logins = 0, locked_until = 0, last_login = ? WHERE id = ?').bind(t, u.id).run();
    await audit(env, u.id, 'login', { ip, ua: (req.headers.get('User-Agent') || '').slice(0, 120) });
    const token = await createSession(env, req, u.id);
    return json({ ok: true, me: publicUser(u) }, 200, { 'Set-Cookie': sessionCookie(token, SESSION_TTL / 1000) });
  }

  // ---------- elfelejtett jelszó ----------
  if (path === '/api/auth/forgot' && req.method === 'POST') {
    const ip = clientIp(req);
    const t = now();
    await env.DB.prepare('DELETE FROM reset_requests WHERE ts < ?')
      .bind(t - 86400_000)
      .run();
    const cnt = await env.DB.prepare('SELECT COUNT(*) AS n FROM reset_requests WHERE ip = ? AND ts > ?')
      .bind(ip, t - 3600_000)
      .first<{ n: number }>();
    if ((cnt?.n || 0) >= 5) throw new HttpError(429, 'Túl sok kérés. Próbáld újra egy óra múlva.');
    await env.DB.prepare('INSERT INTO reset_requests (ip, ts) VALUES (?, ?)').bind(ip, t).run();
    if (!mailEnabled(env)) throw new HttpError(503, 'Az e-mail küldés nincs beállítva. Kérd az adminisztrátort, hogy állítsa vissza a jelszavad.');
    const body = await readJson(req);
    const email = String(body.email || '')
      .trim()
      .toLowerCase();
    const u = await env.DB.prepare('SELECT * FROM users WHERE email = ?').bind(email).first<User>();
    // Mindig ugyanaz a válasz, hogy ne lehessen kideríteni, mely e-mail címek léteznek.
    const generic = json({
      ok: true,
      message: 'Ha ezzel az e-mail címmel van fiók, elküldtük a jelszó-visszaállító linket. Nézd meg a beérkező leveleidet (és a spam mappát).',
    });
    if (!u || u.disabled) return generic;
    const recent = await env.DB.prepare('SELECT COUNT(*) AS n FROM password_resets WHERE user_id = ? AND created_at > ?')
      .bind(u.id, t - 3600_000)
      .first<{ n: number }>();
    if ((recent?.n || 0) >= 3) return generic;
    const token = b64url(randomBytes(32));
    await env.DB.prepare('INSERT INTO password_resets (token_hash, user_id, created_at, expires_at, ip) VALUES (?, ?, ?, ?, ?)')
      .bind(await sha256(token), u.id, t, t + 30 * 60_000, ip)
      .run();
    const link = `${new URL(req.url).origin}/?reset=${token}`;
    try {
      await sendMail(env, { to: u.email, ...resetMail(u.name, link) });
      await audit(env, u.id, 'password_reset_requested', { ip });
    } catch (e: any) {
      console.error('reset mail failed', e?.message);
      await audit(env, u.id, 'password_reset_mail_failed', { error: String(e?.message).slice(0, 200) });
    }
    return generic;
  }

  if (path === '/api/auth/reset-info' && req.method === 'POST') {
    const body = await readJson(req);
    const r = await validResetToken(env, String(body.token || ''));
    if (!r) return json({ valid: false });
    return json({ valid: true, needTotp: !!r.user.totp_enabled, email: r.user.email });
  }

  if (path === '/api/auth/reset' && req.method === 'POST') {
    const body = await readJson(req);
    const r = await validResetToken(env, String(body.token || ''));
    if (!r) throw new HttpError(400, 'A link lejárt vagy már felhasználták. Kérj újat.');
    // a jelszó-visszaállítás nem kerülheti meg a kétlépcsős azonosítást
    if (r.user.totp_enabled && !(await verifyTotp(r.user.totp_secret || '', String(body.totp || '')))) throw new HttpError(400, 'Hibás kétlépcsős kód.');
    const pw = await newPasswordFields(String(body.password || ''));
    const t = now();
    await env.DB.batch([
      env.DB.prepare('UPDATE users SET pw_hash = ?, pw_salt = ?, pw_iter = ?, must_change_pw = 0, failed_logins = 0, locked_until = 0 WHERE id = ?').bind(
        pw.pw_hash,
        pw.pw_salt,
        pw.pw_iter,
        r.user.id,
      ),
      env.DB.prepare('UPDATE password_resets SET used_at = ? WHERE user_id = ? AND used_at IS NULL').bind(t, r.user.id),
      env.DB.prepare('DELETE FROM sessions WHERE user_id = ?').bind(r.user.id),
    ]);
    await audit(env, r.user.id, 'password_reset_done', { ip: clientIp(req) });
    try {
      await sendMail(env, { to: r.user.email, ...changedMail(r.user.name) });
    } catch {}
    return json({ ok: true });
  }

  if (path === '/api/auth/logout' && req.method === 'POST') {
    const token = getCookie(req, COOKIE);
    if (token)
      await env.DB.prepare('DELETE FROM sessions WHERE token_hash = ?')
        .bind(await sha256(token))
        .run();
    return json({ ok: true }, 200, { 'Set-Cookie': sessionCookie('', 0) });
  }

  return null;
}

/** Bejelentkezett felhasználó saját fiók-műveletei. */
export async function handleAccount(env: Env, req: Request, path: string, u: User): Promise<Response | null> {
  if (path === '/api/account/password' && req.method === 'POST') {
    const body = await readJson(req);
    if (!(await verifyPassword(u, String(body.current || '')))) throw new HttpError(400, 'A jelenlegi jelszó hibás.');
    const pw = await newPasswordFields(String(body.next || ''));
    await env.DB.prepare('UPDATE users SET pw_hash = ?, pw_salt = ?, pw_iter = ?, must_change_pw = 0 WHERE id = ?')
      .bind(pw.pw_hash, pw.pw_salt, pw.pw_iter, u.id)
      .run();
    // a többi munkamenet kiléptetése
    const token = getCookie(req, COOKIE) || '';
    await env.DB.prepare('DELETE FROM sessions WHERE user_id = ? AND token_hash != ?')
      .bind(u.id, await sha256(token))
      .run();
    await audit(env, u.id, 'password_changed');
    return json({ ok: true });
  }
  if (path === '/api/account/totp/setup' && req.method === 'POST') {
    if (u.totp_enabled) throw new HttpError(400, 'A kétlépcsős azonosítás már be van kapcsolva.');
    const secret = base32Encode(randomBytes(20));
    await env.DB.prepare('UPDATE users SET totp_secret = ? WHERE id = ?').bind(secret, u.id).run();
    const label = encodeURIComponent('Cashflow:' + u.email);
    return json({ secret, url: `otpauth://totp/${label}?secret=${secret}&issuer=Cashflow&algorithm=SHA1&digits=6&period=30` });
  }
  if (path === '/api/account/totp/enable' && req.method === 'POST') {
    const body = await readJson(req);
    if (!u.totp_secret || !(await verifyTotp(u.totp_secret, String(body.code || '')))) throw new HttpError(400, 'Hibás kód. Ellenőrizd a telefon idejét.');
    await env.DB.prepare('UPDATE users SET totp_enabled = 1 WHERE id = ?').bind(u.id).run();
    await audit(env, u.id, 'totp_enabled');
    return json({ ok: true });
  }
  if (path === '/api/account/totp/disable' && req.method === 'POST') {
    const body = await readJson(req);
    if (!(await verifyPassword(u, String(body.password || '')))) throw new HttpError(400, 'Hibás jelszó.');
    await env.DB.prepare('UPDATE users SET totp_enabled = 0, totp_secret = NULL WHERE id = ?').bind(u.id).run();
    await audit(env, u.id, 'totp_disabled');
    return json({ ok: true });
  }
  if (path === '/api/account/sessions' && req.method === 'DELETE') {
    await env.DB.prepare('DELETE FROM sessions WHERE user_id = ?').bind(u.id).run();
    return json({ ok: true }, 200, { 'Set-Cookie': sessionCookie('', 0) });
  }
  return null;
}

/** Felhasználókezelés (csak admin). */
export async function handleUsers(env: Env, req: Request, path: string, u: User): Promise<Response | null> {
  if (!path.startsWith('/api/users')) return null;
  requireRole(u, 'admin');
  if (path === '/api/users' && req.method === 'GET') {
    const r = await env.DB.prepare('SELECT id, email, name, role, totp_enabled, disabled, last_login, created_at FROM users ORDER BY id').all();
    return json(r.results);
  }
  if (path === '/api/users' && req.method === 'POST') {
    const body = await readJson(req);
    const email = String(body.email || '')
      .trim()
      .toLowerCase();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new HttpError(400, 'Érvénytelen e-mail cím.');
    const role = (['admin', 'member', 'viewer'].includes(body.role) ? body.role : 'member') as Role;
    // ideiglenes jelszó – első belépéskor cserélni kell
    const temp = b64url(randomBytes(12));
    const pw = await newPasswordFields(temp);
    try {
      await env.DB.prepare('INSERT INTO users (email, name, role, pw_hash, pw_salt, pw_iter, must_change_pw, created_at) VALUES (?, ?, ?, ?, ?, ?, 1, ?)')
        .bind(email, String(body.name || email).slice(0, 80), role, pw.pw_hash, pw.pw_salt, pw.pw_iter, now())
        .run();
    } catch {
      throw new HttpError(409, 'Ezzel az e-mail címmel már van felhasználó.');
    }
    await audit(env, u.id, 'user_created', { email, role });
    return json({ ok: true, tempPassword: temp });
  }
  const m = path.match(/^\/api\/users\/(\d+)(\/reset)?$/);
  if (m) {
    const id = Number(m[1]);
    if (m[2] && req.method === 'POST') {
      const temp = b64url(randomBytes(12));
      const pw = await newPasswordFields(temp);
      await env.DB.prepare(
        'UPDATE users SET pw_hash = ?, pw_salt = ?, pw_iter = ?, must_change_pw = 1, totp_enabled = 0, totp_secret = NULL, locked_until = 0 WHERE id = ?',
      )
        .bind(pw.pw_hash, pw.pw_salt, pw.pw_iter, id)
        .run();
      await env.DB.prepare('DELETE FROM sessions WHERE user_id = ?').bind(id).run();
      await audit(env, u.id, 'user_reset', { id });
      return json({ ok: true, tempPassword: temp });
    }
    if (req.method === 'PATCH') {
      const body = await readJson(req);
      if (id === u.id && ((body.role && body.role !== 'admin') || body.disabled)) throw new HttpError(400, 'Saját magad nem fokozhatod le / tilthatod le.');
      if (body.role && ['admin', 'member', 'viewer'].includes(body.role))
        await env.DB.prepare('UPDATE users SET role = ? WHERE id = ?').bind(body.role, id).run();
      if (body.disabled !== undefined) {
        await env.DB.prepare('UPDATE users SET disabled = ? WHERE id = ?')
          .bind(body.disabled ? 1 : 0, id)
          .run();
        if (body.disabled) await env.DB.prepare('DELETE FROM sessions WHERE user_id = ?').bind(id).run();
      }
      await audit(env, u.id, 'user_updated', { id, ...body });
      return json({ ok: true });
    }
    if (req.method === 'DELETE') {
      if (id === u.id) throw new HttpError(400, 'Saját magadat nem törölheted.');
      await env.DB.prepare('DELETE FROM sessions WHERE user_id = ?').bind(id).run();
      await env.DB.prepare('DELETE FROM users WHERE id = ?').bind(id).run();
      await audit(env, u.id, 'user_deleted', { id });
      return json({ ok: true });
    }
  }
  return null;
}
