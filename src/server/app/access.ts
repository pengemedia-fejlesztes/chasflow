// Hozzáférés-kezelés: felhasználónkénti menüpontok és adatkörök, kötelező kétlépcsős azonosítás, meghívó link.
import { cleanAccess, type Access, type TwoFaMode } from '../../shared/access';
import { requireRole, type User } from './auth';
import { logChange } from './changelog';
import { Env, HttpError, b64url, getSetting, json, now, readJson, setSetting, sha256 } from './util';

export async function loadAccessMap(env: Env): Promise<Record<string, Access>> {
  try {
    const raw = JSON.parse((await getSetting(env, 'user_access')) || '{}');
    return Object.fromEntries(Object.entries(raw).map(([k, v]) => [k, cleanAccess(v)]));
  } catch {
    return {};
  }
}

export async function setUserAccess(env: Env, userId: number, a: unknown) {
  const all = await loadAccessMap(env);
  all[String(userId)] = cleanAccess(a);
  await setSetting(env, 'user_access', JSON.stringify(all));
}

/** kötelező 2FA: a beállítás, különben a régi környezeti kapcsoló (csak adminoknak) */
export async function twofaMode(env: Env): Promise<TwoFaMode> {
  // kikapcsolva (Laci kérése, 2026-11-08): senkitől nem kérünk kétlépcsős kódot
  void env;
  return 'off';
}

/**
 * Meghívó: egyszer használható, 7 napig érvényes link-token (a jelszó-visszaállítás táblájában), amellyel a meghívott
 * maga állítja be a jelszavát – jelszót így senki más nem lát. A link a felületen jelenik meg, az admin küldi el.
 */
export async function createInvite(env: Env, userId: number): Promise<string> {
  const token = b64url(crypto.getRandomValues(new Uint8Array(32)));
  const t = now();
  await env.DB.prepare('UPDATE password_resets SET used_at = ? WHERE user_id = ? AND used_at IS NULL').bind(t, userId).run();
  await env.DB.prepare('INSERT INTO password_resets (token_hash, user_id, created_at, expires_at, ip) VALUES (?, ?, ?, ?, ?)')
    .bind(await sha256(token), userId, t, t + 7 * 86400_000, 'invite')
    .run();
  return token;
}

export async function handleAccess(env: Env, req: Request, path: string, u: User): Promise<Response | null> {
  if (path === '/api/security' && req.method === 'PUT') {
    requireRole(u, 'admin');
    const b = await readJson(req);
    const mode = ['admin', 'all'].includes(b.require_2fa) ? (b.require_2fa as TwoFaMode) : null;
    if (!mode) throw new HttpError(400, 'Hibás beállítás.');
    if (mode !== 'off' && !u.totp_enabled)
      throw new HttpError(400, 'Előbb kapcsold be a saját kétlépcsős azonosításodat (Beállítások › Fiók), különben kizárnád magad.');
    await setSetting(env, 'require_2fa', mode);
    await logChange(
      env,
      u.id,
      'security',
      `Kétlépcsős azonosítás kötelező: ${mode === 'all' ? 'mindenkinek' : mode === 'admin' ? 'adminoknak' : 'senkinek'}`,
      [],
      null,
    );
    return json({ ok: true });
  }
  const m = path.match(/^\/api\/users\/(\d+)\/(access|invite)$/);
  if (!m) return null;
  requireRole(u, 'admin');
  const id = Number(m[1]);
  const target = await env.DB.prepare('SELECT id, email, name, role FROM users WHERE id = ?')
    .bind(id)
    .first<{ id: number; email: string; name: string; role: string }>();
  if (!target) throw new HttpError(404, 'Nincs ilyen felhasználó.');
  if (m[2] === 'access' && req.method === 'PUT') {
    const b = await readJson(req);
    await setUserAccess(env, id, b);
    const a = cleanAccess(b);
    await logChange(env, u.id, 'user_access', `Hozzáférés módosítva: ${target.name} (${a.menus.length} menüpont)`, [], null);
    return json({ ok: true });
  }
  if (m[2] === 'invite' && req.method === 'POST') {
    const token = await createInvite(env, id);
    await logChange(env, u.id, 'user_invite', `Új meghívó link: ${target.name} (${target.email})`, [], null);
    return json({ ok: true, inviteToken: token });
  }
  return null;
}
