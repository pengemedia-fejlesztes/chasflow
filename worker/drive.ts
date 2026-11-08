// Google Drive mentés: a tételekhez feltöltött számlák másolata a kiválasztott Google-fiók kiválasztott mappájába.
// Beállítás (admin, Beállítások › Bekötések): Google OAuth-kliens (azonosító + titok, a Google Cloud Console-ból),
// Google-fiók összekötése (egyszeri belépés a Google-nál), mappa kiválasztása. A titkok a szerver titkos táblájában vannak,
// a böngészőkbe nem kerülnek ki.
import { requireRole, type User } from './auth';
import { logChange } from './changelog';
import { afterUpload, ensureTxFiles, readTxFile } from './txfiles';
import { Env, HttpError, getSetting, json, now, randomId, readJson, setSetting } from './util';

const SCOPES = 'https://www.googleapis.com/auth/drive https://www.googleapis.com/auth/userinfo.email';

async function secretGet(env: Env, name: string): Promise<string | null> {
  await env.DB.prepare(
    'CREATE TABLE IF NOT EXISTS secrets (name VARCHAR(60) NOT NULL PRIMARY KEY, value TEXT NOT NULL, meta TEXT, updated_at BIGINT NOT NULL)',
  ).run();
  const r = await env.DB.prepare('SELECT value FROM secrets WHERE name = ?').bind(name).first<{ value: string }>();
  return r ? r.value : null;
}
async function secretSet(env: Env, name: string, value: string | null) {
  await secretGet(env, name);
  if (value === null) await env.DB.prepare('DELETE FROM secrets WHERE name = ?').bind(name).run();
  else
    await env.DB.prepare(
      'INSERT INTO secrets (name, value, meta, updated_at) VALUES (?, ?, NULL, ?) ON CONFLICT(name) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at',
    )
      .bind(name, value, now())
      .run();
}

export interface DriveStatus {
  clientSet: boolean;
  email: string | null;
  folder: { id: string; name: string } | null;
  redirectUri?: string;
}

export async function driveStatus(env: Env, origin?: string): Promise<DriveStatus> {
  const client = await secretGet(env, 'google_client').catch(() => null);
  const tok = JSON.parse((await secretGet(env, 'google_token').catch(() => null)) || 'null');
  const folder = JSON.parse((await getSetting(env, 'drive_folder')) || 'null');
  return { clientSet: !!client, email: tok?.email || null, folder, ...(origin ? { redirectUri: redirectUri(env, origin) } : {}) };
}

const redirectUri = (env: Env, origin: string) => `${origin}${String((env as any).BASE_PATH || '').replace(/\/+$/, '')}/api/google/callback`;

async function accessToken(env: Env): Promise<string> {
  const client = JSON.parse((await secretGet(env, 'google_client')) || 'null');
  const tok = JSON.parse((await secretGet(env, 'google_token')) || 'null');
  if (!client || !tok?.refresh_token) throw new HttpError(400, 'Nincs összekötve Google-fiók.');
  if (tok.access_token && tok.expires_at > now() + 60_000) return tok.access_token;
  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: client.id, client_secret: client.secret, refresh_token: tok.refresh_token, grant_type: 'refresh_token' }),
  });
  const d: any = await r.json().catch(() => ({}));
  if (!r.ok || !d.access_token)
    throw new HttpError(502, 'Google: a hozzáférés megújítása nem sikerült – kösd össze újra a fiókot (' + (d.error || r.status) + ').');
  await secretSet(env, 'google_token', JSON.stringify({ ...tok, access_token: d.access_token, expires_at: now() + Number(d.expires_in || 3600) * 1000 }));
  return d.access_token;
}

/** egy feltöltött számla másolása a Drive-mappába; a fájl neve: dátum – partner – összeg – eredeti név */
export async function uploadToDrive(env: Env, fileId: string): Promise<{ id: string; link: string } | null> {
  const folder = JSON.parse((await getSetting(env, 'drive_folder')) || 'null');
  if (!folder?.id) return null;
  await ensureTxFiles(env);
  const meta = await env.DB.prepare(
    'SELECT f.id, f.name, f.mime, f.drive_id, t.date, t.amount, t.partner FROM tx_files f LEFT JOIN bank_tx t ON t.id = f.tx_id WHERE f.id = ?',
  )
    .bind(fileId)
    .first<any>();
  if (!meta || meta.drive_id) return null;
  const f = await readTxFile(env, fileId);
  if (!f) return null;
  const token = await accessToken(env);
  const name = `${meta.date || ''} – ${String(meta.partner || 'tétel').slice(0, 60)} – ${meta.amount ?? ''} Ft – ${meta.name}`.replace(/[\\/]/g, '_');
  const boundary = 'cf' + randomId('b');
  const head = `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify({ name, parents: [folder.id] })}\r\n--${boundary}\r\nContent-Type: ${f.mime}\r\n\r\n`;
  const tail = `\r\n--${boundary}--`;
  const body = new Uint8Array([...new TextEncoder().encode(head), ...f.data, ...new TextEncoder().encode(tail)]);
  const r = await fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,webViewLink&supportsAllDrives=true', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + token, 'Content-Type': `multipart/related; boundary=${boundary}` },
    body,
  });
  const d: any = await r.json().catch(() => ({}));
  if (!r.ok || !d.id) throw new Error('Drive-feltöltés sikertelen: ' + (d.error?.message || r.status));
  await env.DB.prepare('UPDATE tx_files SET drive_id = ?, drive_link = ? WHERE id = ?')
    .bind(d.id, d.webViewLink || null, fileId)
    .run();
  return { id: d.id, link: d.webViewLink || '' };
}

// minden új feltöltés után automatikusan a Drive-ba is (ha be van állítva)
afterUpload.hook = async (env, id) => {
  await uploadToDrive(env, id).catch((e) => console.error('drive upload', e?.message || e));
};

export async function handleDrive(env: Env, req: Request, path: string, u: User): Promise<Response | null> {
  if (!path.startsWith('/api/google')) return null;
  requireRole(u, 'admin');
  const url = new URL(req.url);
  if (path === '/api/google/status' && req.method === 'GET') return json(await driveStatus(env, url.origin));
  if (path === '/api/google/client' && req.method === 'PUT') {
    const b = await readJson(req);
    const id = String(b.client_id || '').trim();
    const secret = String(b.client_secret || '').trim();
    if (!/\.apps\.googleusercontent\.com$/.test(id) || secret.length < 10) throw new HttpError(400, 'Hibás OAuth-kliens azonosító vagy titok.');
    await secretSet(env, 'google_client', JSON.stringify({ id, secret }));
    await logChange(env, u.id, 'google_client', 'Google OAuth-kliens beállítva', [], null);
    return json({ ok: true });
  }
  if (path === '/api/google/auth' && req.method === 'GET') {
    const client = JSON.parse((await secretGet(env, 'google_client')) || 'null');
    if (!client) throw new HttpError(400, 'Előbb add meg a Google OAuth-kliens adatait.');
    const state = randomId('g');
    await setSetting(env, 'google_oauth_state', JSON.stringify({ state, at: now(), user: u.id }));
    const q = new URLSearchParams({
      client_id: client.id,
      redirect_uri: redirectUri(env, url.origin),
      response_type: 'code',
      scope: SCOPES,
      access_type: 'offline',
      prompt: 'consent select_account',
      state,
    });
    return json({ url: 'https://accounts.google.com/o/oauth2/v2/auth?' + q.toString() });
  }
  if (path === '/api/google/callback' && req.method === 'GET') {
    const back = (msg: string) =>
      Response.redirect(`${url.origin}${String((env as any).BASE_PATH || '').replace(/\/+$/, '')}/?google=${encodeURIComponent(msg)}#/settings`, 302);
    const st = JSON.parse((await getSetting(env, 'google_oauth_state')) || 'null');
    if (!st || st.state !== url.searchParams.get('state') || now() - st.at > 15 * 60_000) return back('A kérés lejárt, próbáld újra.');
    await setSetting(env, 'google_oauth_state', '');
    const code = url.searchParams.get('code');
    if (!code) return back(url.searchParams.get('error') || 'A Google megszakította.');
    const client = JSON.parse((await secretGet(env, 'google_client')) || 'null');
    const r = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: client.id,
        client_secret: client.secret,
        code,
        redirect_uri: redirectUri(env, url.origin),
        grant_type: 'authorization_code',
      }),
    });
    const d: any = await r.json().catch(() => ({}));
    if (!r.ok || !d.refresh_token) return back('A Google nem adott hozzáférést (' + (d.error_description || d.error || r.status) + ').');
    const who: any = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', { headers: { Authorization: 'Bearer ' + d.access_token } })
      .then((x) => x.json())
      .catch(() => ({}));
    await secretSet(
      env,
      'google_token',
      JSON.stringify({
        refresh_token: d.refresh_token,
        access_token: d.access_token,
        expires_at: now() + Number(d.expires_in || 3600) * 1000,
        email: who.email || null,
      }),
    );
    await logChange(env, u.id, 'google_connect', `Google Drive összekötve: ${who.email || ''}`, [], null);
    return back('ok');
  }
  if (path === '/api/google/folders' && req.method === 'GET') {
    const token = await accessToken(env);
    const q = String(url.searchParams.get('q') || '')
      .replace(/'/g, "\\'")
      .slice(0, 80);
    const query = `mimeType = 'application/vnd.google-apps.folder' and trashed = false${q ? ` and name contains '${q}'` : ''}`;
    const r = await fetch(
      'https://www.googleapis.com/drive/v3/files?' +
        new URLSearchParams({
          q: query,
          fields: 'files(id,name,parents)',
          pageSize: '50',
          orderBy: 'modifiedTime desc',
          includeItemsFromAllDrives: 'true',
          supportsAllDrives: 'true',
        }),
      { headers: { Authorization: 'Bearer ' + token } },
    );
    const d: any = await r.json().catch(() => ({}));
    if (!r.ok) throw new HttpError(502, 'Drive: ' + (d.error?.message || r.status));
    return json({ folders: (d.files || []).map((f: any) => ({ id: f.id, name: f.name })) });
  }
  if (path === '/api/google/folder' && req.method === 'PUT') {
    const b = await readJson(req);
    const id = String(b.id || '').trim();
    if (!/^[\w-]{10,}$/.test(id)) throw new HttpError(400, 'Hibás mappa.');
    await setSetting(env, 'drive_folder', JSON.stringify({ id, name: String(b.name || '').slice(0, 120) }));
    await logChange(env, u.id, 'drive_folder', `Számlák Drive-mappája: ${b.name || id}`, [], null);
    return json({ ok: true });
  }
  if (path === '/api/google/sync-files' && req.method === 'POST') {
    // a még nem másolt feltöltött számlák pótlása a Drive-ba
    await ensureTxFiles(env);
    const pending = (await env.DB.prepare('SELECT id FROM tx_files WHERE drive_id IS NULL ORDER BY created_at LIMIT 50').all<{ id: string }>()).results;
    let ok = 0;
    const errors: string[] = [];
    for (const p of pending) {
      try {
        if (await uploadToDrive(env, p.id)) ok++;
      } catch (e: any) {
        errors.push(e.message);
      }
    }
    return json({ ok: true, uploaded: ok, pending: pending.length, errors: errors.slice(0, 3) });
  }
  if (path === '/api/google' && req.method === 'DELETE') {
    await secretSet(env, 'google_token', null);
    await logChange(env, u.id, 'google_disconnect', 'Google Drive leválasztva', [], null);
    return json({ ok: true });
  }
  return null;
}
