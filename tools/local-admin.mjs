// Lokalis admin felhasznalo letrehozasa / jelszavanak beallitasa egy SQLite-adatbazisban.
// CSAK fejleszteshez (pl. egy eles adatbol keszult lokalis masolathoz, ahol nem ismerjuk a jelszavakat).
//
//   node tools/local-admin.mjs <db.sqlite> <email> <jelszo> [nev]
//
// A jelszo-hash ugyanaz, mint az appban (worker/auth.ts): PBKDF2-SHA256, 100 000 kor, base64url.
import { DatabaseSync } from 'node:sqlite';
import { pbkdf2Sync, randomBytes } from 'node:crypto';

const [path, email, password, name] = process.argv.slice(2);
if (!path || !email || !password) {
  console.error('Hasznalat: node tools/local-admin.mjs <db.sqlite> <email> <jelszo> [nev]');
  process.exit(2);
}
if (password.length < 12) {
  console.error('A jelszo legalabb 12 karakter legyen (mint az appban).');
  process.exit(2);
}
const ITER = 100_000;
const salt = randomBytes(16);
const hash = pbkdf2Sync(password, salt, ITER, 32, 'sha256').toString('base64url');

const db = new DatabaseSync(path);
db.exec('PRAGMA busy_timeout = 5000');
const em = email.trim().toLowerCase();
const exists = db.prepare('SELECT id FROM users WHERE email = ?').get(em);
if (exists) {
  db.prepare(
    "UPDATE users SET pw_hash = ?, pw_salt = ?, pw_iter = ?, role = 'admin', must_change_pw = 0, failed_logins = 0, locked_until = 0, disabled = 0, totp_enabled = 0, totp_secret = NULL WHERE id = ?",
  ).run(hash, salt.toString('base64url'), ITER, exists.id);
  console.log(`Frissitve: ${em} (id ${exists.id}) – admin, uj jelszo, 2FA kikapcsolva`);
} else {
  const r = db
    .prepare('INSERT INTO users (email, name, role, pw_hash, pw_salt, pw_iter, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(em, name || 'Lokalis admin', 'admin', hash, salt.toString('base64url'), ITER, Date.now());
  console.log(`Letrehozva: ${em} (id ${r.lastInsertRowid}) – admin`);
}
db.close();
