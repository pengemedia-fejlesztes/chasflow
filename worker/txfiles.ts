// Banki / készpénzes tételhez feltöltött számla (PDF, kép) – igazolás, hogy a tétel valóban megtörtént.
// A fájl a szerveren, az alkalmazás mappáján belüli, kívülről nem elérhető „uploads” mappába kerül; a felhasználó csak
// bejelentkezve töltheti le. (Google Drive-ba másolás: lásd a Drive-beállítást.)
import { requireRole, type User } from './auth';
import { logChange } from './changelog';
import { Env, HttpError, json, now, randomId, readJson } from './util';

const DDL = `CREATE TABLE IF NOT EXISTS tx_files (
  id VARCHAR(40) NOT NULL PRIMARY KEY,
  tx_id VARCHAR(60) NOT NULL,
  name VARCHAR(200) NOT NULL,
  mime VARCHAR(80) NOT NULL,
  size INTEGER NOT NULL,
  path VARCHAR(300) NOT NULL,
  drive_id VARCHAR(120),
  drive_link VARCHAR(400),
  created_by INTEGER,
  created_at BIGINT NOT NULL
)`;
let ready: Promise<boolean> | null = null;
export function ensureTxFiles(env: Env): Promise<boolean> {
  if (!ready)
    ready = env.DB.prepare(DDL)
      .run()
      .then(() => true)
      .catch((e) => {
        ready = null;
        console.error('tx_files ddl', e);
        return false;
      });
  return ready;
}

const MAX = 10 * 1024 * 1024;
const MIMES = new Set(['application/pdf', 'image/jpeg', 'image/png', 'image/heic', 'image/webp', 'application/xml', 'text/xml']);

export interface TxFile {
  id: string;
  tx_id: string;
  name: string;
  mime: string;
  size: number;
  drive_link: string | null;
  created_at: number;
}

async function fsMod() {
  const fs = await import('node:fs/promises');
  const path = await import('node:path');
  const dir = (globalThis as any).process?.env?.UPLOAD_DIR || path.join((globalThis as any).process?.cwd?.() || '.', 'uploads');
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  return { fs, path, dir };
}

export async function filesFor(env: Env, txIds: string[]): Promise<Map<string, TxFile[]>> {
  const out = new Map<string, TxFile[]>();
  if (!txIds.length || !(await ensureTxFiles(env))) return out;
  const r = await env.DB.prepare(
    `SELECT id, tx_id, name, mime, size, drive_link, created_at FROM tx_files WHERE tx_id IN (${txIds.map(() => '?').join(',')}) ORDER BY created_at`,
  )
    .bind(...txIds)
    .all<TxFile>();
  for (const f of r.results) out.set(f.tx_id, [...(out.get(f.tx_id) || []), { ...f, size: Number(f.size), created_at: Number(f.created_at) }]);
  return out;
}

/** feltöltés után hívódik (pl. Google Drive-ba másolás) – a drive.ts állítja be */
export const afterUpload: { hook: ((env: Env, fileId: string) => Promise<void>) | null } = { hook: null };

export async function readTxFile(env: Env, id: string): Promise<{ name: string; mime: string; data: Uint8Array } | null> {
  await ensureTxFiles(env);
  const f = await env.DB.prepare('SELECT name, mime, path FROM tx_files WHERE id = ?').bind(id).first<{ name: string; mime: string; path: string }>();
  if (!f) return null;
  const { fs, path, dir } = await fsMod();
  const full = path.join(dir, path.basename(f.path));
  return { name: f.name, mime: f.mime, data: new Uint8Array(await fs.readFile(full)) };
}

export async function handleTxFiles(env: Env, req: Request, path: string, u: User): Promise<Response | null> {
  const up = path.match(/^\/api\/bank\/tx\/([^/]+)\/file$/);
  const one = path.match(/^\/api\/bank\/file\/([^/]+)$/);
  if (!up && !one) return null;
  if (!(await ensureTxFiles(env))) throw new HttpError(500, 'A mellékletek táblája nem hozható létre.');

  if (up && req.method === 'POST') {
    requireRole(u, 'admin', 'member');
    const txId = decodeURIComponent(up[1]).slice(0, 60);
    const tx = await env.DB.prepare('SELECT id, date, amount, partner FROM bank_tx WHERE id = ?').bind(txId).first<any>();
    if (!tx) throw new HttpError(404, 'Nincs ilyen tétel.');
    const b = await readJson<{ name?: string; mime?: string; data?: string }>(req, 15_000_000);
    const mime = String(b.mime || '').toLowerCase();
    if (!MIMES.has(mime)) throw new HttpError(400, 'Csak PDF, kép (JPG, PNG, HEIC, WEBP) vagy XML számla tölthető fel.');
    const bin = Uint8Array.from(atob(String(b.data || '')), (c) => c.charCodeAt(0));
    if (!bin.length || bin.length > MAX) throw new HttpError(400, 'A fájl üres vagy nagyobb 10 MB-nál.');
    const name = String(b.name || 'szamla')
      .replace(/[\\/\0]/g, '_')
      .slice(0, 180);
    const id = randomId('f');
    const ext = (name.match(/\.[a-z0-9]{1,5}$/i)?.[0] || '').toLowerCase();
    const { fs, path: p, dir } = await fsMod();
    const file = id + ext;
    await fs.writeFile(p.join(dir, file), bin, { mode: 0o600 });
    await env.DB.prepare('INSERT INTO tx_files (id, tx_id, name, mime, size, path, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .bind(id, txId, name, mime, bin.length, file, u.id, now())
      .run();
    await logChange(env, u.id, 'tx_file', `Számla feltöltve: ${name} · ${tx.partner || ''} ${tx.amount} Ft (${tx.date})`, [], null);
    if (afterUpload.hook) await afterUpload.hook(env, id).catch((e) => console.error('after upload', e));
    return json({ ok: true, id });
  }
  if (one && req.method === 'GET') {
    const f = await readTxFile(env, decodeURIComponent(one[1]));
    if (!f) throw new HttpError(404, 'Nincs ilyen fájl.');
    return new Response(f.data as unknown as BodyInit, {
      headers: {
        'Content-Type': f.mime,
        'Content-Disposition': `inline; filename*=UTF-8''${encodeURIComponent(f.name)}`,
        'Cache-Control': 'private, no-store',
        'X-Content-Type-Options': 'nosniff',
      },
    });
  }
  if (one && req.method === 'DELETE') {
    requireRole(u, 'admin', 'member');
    const id = decodeURIComponent(one[1]);
    const f = await env.DB.prepare('SELECT name, path FROM tx_files WHERE id = ?').bind(id).first<{ name: string; path: string }>();
    if (!f) throw new HttpError(404, 'Nincs ilyen fájl.');
    const { fs, path: p, dir } = await fsMod();
    await fs.unlink(p.join(dir, p.basename(f.path))).catch(() => null);
    await env.DB.prepare('DELETE FROM tx_files WHERE id = ?').bind(id).run();
    await logChange(env, u.id, 'tx_file_deleted', `Feltöltött számla törölve: ${f.name}`, [], null);
    return json({ ok: true });
  }
  return null;
}
