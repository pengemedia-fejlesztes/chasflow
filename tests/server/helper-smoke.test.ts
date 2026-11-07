import { afterEach, describe, expect, it } from 'vitest';
import { createTestApp, type TestApp } from '../helpers/app';

let t: TestApp | undefined;
afterEach(() => t?.close());

describe('teszt-segéd (valódi backend, memóriabeli SQLite)', () => {
  it('bejelentkezett admin, az adatcsomag lekérhető', async () => {
    t = await createTestApp();
    const me = await t.get('/api/auth/status');
    expect(me.status).toBe(200);
    expect(me.data.me.role).toBe('admin');
    const data = await t.get('/api/data');
    expect(data.status).toBe(200);
  });
  it('bejelentkezés nélkül az adat nem érhető el', async () => {
    t = await createTestApp({ login: false });
    const data = await t.get('/api/data');
    expect(data.status).toBe(401);
  });
});
