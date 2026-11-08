// Utemezett szinkron: a backend scheduled() kezelojet hivja (eles: cPanel cron).
// Futtatas a repo gyokereben: node src/server/runtime/cron.mjs
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import worker from '../../../dist/server/worker.mjs';
import { openDb } from './db.mjs';

const ROOT = fileURLToPath(new URL('../../..', import.meta.url)); // a repo gyokere
try {
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

const db = await openDb(ROOT, { migrate: false }); // a migraciot a webes folyamat vegzi

const env = { ...process.env, DB: db, ASSETS: { fetch: async () => new Response('', { status: 404 }) } };

const pending = [];
const ctx = {
  waitUntil(p) {
    pending.push(Promise.resolve(p).catch((e) => console.error('hiba', e)));
  },
  passThroughOnException() {},
};

const t0 = Date.now();
await worker.scheduled({ scheduledTime: Date.now(), cron: process.argv[2] || 'cpanel' }, env, ctx);
await Promise.allSettled(pending);
console.log(`[${new Date().toISOString()}] szinkron kesz ${Date.now() - t0} ms`);
process.exit(0);
