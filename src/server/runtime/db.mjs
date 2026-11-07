// Adatbazis kivalasztasa a kornyezeti valtozok alapjan (az entry.mjs es a cron.mjs kozos resze).
//   SQLITE_PATH megadva -> SQLite (node:sqlite), indulaskor lefuttatja a migrations/ mappat
//   kulonben           -> MySQL (DB_HOST, DB_USER, DB_PASSWORD, DB_NAME) – a mostani eles beallitas
// A modulokat dinamikusan toltjuk, hogy a nem hasznalt meghajto ne induljon el.
import { isAbsolute, join } from 'node:path';

export async function openDb(root, { migrate = true } = {}) {
  const p = process.env.SQLITE_PATH;
  if (p) {
    const { createSqliteDb } = await import('./d1-sqlite.mjs');
    return createSqliteDb({
      path: isAbsolute(p) ? p : join(root, p),
      migrationsDir: migrate ? join(root, 'migrations') : null,
    });
  }
  const { createDb } = await import('./d1-mysql.mjs');
  return createDb({
    host: process.env.DB_HOST || '127.0.0.1',
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
  });
}
