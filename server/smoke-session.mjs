// Fustteszt: ideiglenes munkamenet-sor beszurasa, hogy az adat-vegpontokat ellenorizni lehessen.
import { createDb } from './d1-mysql.mjs';
import crypto from 'node:crypto';

const db = createDb({
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
});

const token = 'smoke-' + crypto.randomBytes(24).toString('hex');
const hash = crypto.createHash('sha256').update(token).digest('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const t = Date.now();
const u = await db.prepare('SELECT id FROM users ORDER BY id LIMIT 1').first();
await db
  .prepare('INSERT INTO sessions (token_hash, user_id, created_at, expires_at, last_seen, ip, user_agent) VALUES (?, ?, ?, ?, ?, ?, ?)')
  .bind(hash, u.id, t, t + 3600_000, t, '127.0.0.1', 'smoke')
  .run();
console.log(token);
process.exit(0);
