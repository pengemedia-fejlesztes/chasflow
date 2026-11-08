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
  it('hozzáférés-beállítás nélküli szerkesztő: tételt nem írhat (alapból tiltás); a segéd alapértéke (teljes hozzáférés) mellett igen', async () => {
    t = await createTestApp();
    await t.addUser('nincs@teszt.hu', 'member', undefined, null);
    await t.loginAs('nincs@teszt.hu');
    expect((await t.post('/api/entries/batch', { upsert: [] })).status).toBe(403);
    await t.addUser('van@teszt.hu', 'member');
    await t.loginAs('van@teszt.hu');
    expect((await t.post('/api/entries/batch', { upsert: [] })).status).toBe(200);
  });
  it('bejelentkezés nélkül az adat nem érhető el', async () => {
    t = await createTestApp({ login: false });
    const data = await t.get('/api/data');
    expect(data.status).toBe(401);
  });
});
