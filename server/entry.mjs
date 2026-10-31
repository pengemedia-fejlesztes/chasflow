// Cashflow tervezo - Node belepesi pont a sajat tarhelyen (Cloudflare Worker helyett).
// A Worker fetch/scheduled kezeloit valtozatlanul hasznalja; a D1-t MySQL helyettesiti,
// a statikus fajlokat (dist/) maga szolgalja ki.
import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import worker from '../dist-worker/worker.mjs';
import { createDb } from './d1-mysql.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

// .env betoltese (a Passenger nem olvassa be magatol)
try {
  const { readFileSync } = await import('node:fs');
  const txt = readFileSync(join(ROOT, '.env'), 'utf8');
  for (const line of txt.split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && process.env[m[1]] === undefined) {
      let v = m[2];
      if (v.startsWith('"') && v.endsWith('"')) v = v.slice(1, -1).replace(/\\n/g, '\n').replace(/\\\\/g, '\\');
      process.env[m[1]] = v;
    }
  }
} catch {}
const STATIC_DIR = join(ROOT, 'dist');
const BASE = (process.env.BASE_PATH || '').replace(/\/+$/, ''); // pl. /Cashflow

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
  '.woff2': 'font/woff2',
};

const db = createDb({
  host: process.env.DB_HOST || '127.0.0.1',
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
});

// statikus fajlok Fetcher-kent (az ASSETS binding helyett)
const ASSETS = {
  async fetch(req) {
    const url = new URL(req.url);
    let p = decodeURIComponent(url.pathname);
    if (BASE && p.startsWith(BASE)) p = p.slice(BASE.length) || '/';
    let file = normalize(join(STATIC_DIR, p));
    if (!file.startsWith(STATIC_DIR)) return new Response('Tiltott', { status: 403 });
    try {
      const st = await stat(file);
      if (st.isDirectory()) file = join(file, 'index.html');
    } catch {
      file = join(STATIC_DIR, 'index.html'); // SPA fallback
    }
    try {
      const body = await readFile(file);
      const type = MIME[extname(file).toLowerCase()] || 'application/octet-stream';
      const cache = file.includes('/assets/') ? 'public, max-age=31536000, immutable' : 'no-cache';
      return new Response(body, { headers: { 'content-type': type, 'cache-control': cache } });
    } catch {
      return new Response('Nincs ilyen oldal.', { status: 404 });
    }
  },
};

const env = { ...process.env, DB: db, ASSETS };

const ctx = {
  waitUntil(p) {
    Promise.resolve(p).catch((e) => console.error('waitUntil hiba', e));
  },
  passThroughOnException() {},
};

function toRequest(req) {
  const proto = req.headers['x-forwarded-proto'] || 'https';
  const host = req.headers.host || 'localhost';
  let path = req.url || '/';
  if (BASE && path.startsWith(BASE)) path = path.slice(BASE.length) || '/';
  const url = `${proto}://${host}${path}`;
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) {
    if (Array.isArray(v)) v.forEach((x) => headers.append(k, x));
    else if (v !== undefined) headers.set(k, String(v));
  }
  const method = req.method || 'GET';
  const hasBody = method !== 'GET' && method !== 'HEAD';
  return new Request(url, {
    method,
    headers,
    body: hasBody ? req : undefined,
    duplex: hasBody ? 'half' : undefined,
  });
}

const server = http.createServer(async (req, res) => {
  try {
    const request = toRequest(req);
    const out = await worker.fetch(request, env, ctx);
    res.statusCode = out.status;
    out.headers.forEach((v, k) => {
      if (k.toLowerCase() === 'content-encoding') return;
      res.setHeader(k, v);
    });
    const buf = Buffer.from(await out.arrayBuffer());
    res.end(buf);
  } catch (e) {
    console.error('kereshiba', e);
    res.statusCode = 500;
    res.setHeader('content-type', 'application/json; charset=utf-8');
    res.end(JSON.stringify({ error: 'Szerverhiba. Probald ujra kesobb.' }));
  }
});

const port = Number(process.env.PORT || 3000);
server.listen(port, () => console.log(`cashflow fut: ${port}, alap utvonal: ${BASE || '/'}`));

export { env, ctx, worker };
