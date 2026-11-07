// Kategóriák: alkategória felvétele, átnevezése, archiválása, áthelyezése – és a tételek előjelének védelme.
import { afterEach, describe, expect, it } from 'vitest';
import { createTestApp, type TestApp } from '../helpers/app';
import { openTab, setupLeaves } from '../helpers/adatok-client';
import { genSeries } from '../../src/client/logic';

let t: TestApp | undefined;
afterEach(() => t?.close());

describe('kategóriák', () => {
  it('ugyanazzal a névvel újra felvett alkategória a meglévő (nincs dupla), és újra aktív lesz', async () => {
    t = await createTestApp();
    const L = await setupLeaves(t);
    await t.patch(`/api/leaves/${L.minta}`, { archived: true });
    const r = await t.post('/api/leaves', { group_id: L.gin, label: 'minta kft' });
    expect(r.data.id).toBe(L.minta);
    expect((t.sql.prepare('SELECT archived FROM leaves WHERE id = ?').get(L.minta) as any).archived).toBe(0);
  });

  it('átnevezés naplózva és visszavonható', async () => {
    t = await createTestApp();
    const L = await setupLeaves(t);
    await t.patch(`/api/leaves/${L.alfa}`, { label: 'Alfa Kft.' });
    const log = (await t.get('/api/changelog')).data.items as any[];
    expect(log[0]).toMatchObject({ action: 'leaf.update' });
    expect(log[0].summary).toContain('Alfa Bt. → Alfa Kft.');
    await t.post(`/api/changelog/${log[0].id}/undo`, {});
    expect((t.sql.prepare('SELECT label FROM leaves WHERE id = ?').get(L.alfa) as any).label).toBe('Alfa Bt.');
  });

  it('tételekkel rendelkező alkategória nem tehető át bevételből kiadásba (az előjel nem illene); azonos oldalon igen', async () => {
    t = await createTestApp();
    const L = await setupLeaves(t);
    const tab = await openTab(t);
    await tab.commit(genSeries({ leaf: L.minta, section: 'in', name: 'Havi díj', amount: 250_000, startYm: '2026-12', count: 1, rep: 'once', day: 10 }));
    expect((await t.patch(`/api/leaves/${L.minta}`, { group_id: L.gout })).status).toBe(400);
    expect((t.sql.prepare('SELECT group_id FROM leaves WHERE id = ?').get(L.minta) as any).group_id).toBe(L.gin);
    // kiadáson belül, másik mappába: rendben
    await tab.commit(genSeries({ leaf: L.szoftver, section: 'out', name: 'Adobe', amount: 25_000, startYm: '2026-12', count: 1, rep: 'once', day: 3 }));
    expect((await t.patch(`/api/leaves/${L.szoftver}`, { group_id: L.gwage })).status).toBe(200);
    // üres alkategória szabadon mozgatható
    expect((await t.patch(`/api/leaves/${L.alfa}`, { group_id: L.gout })).status).toBe(200);
  });

  it('bevételi és kiadási partner „összevonása” nem mozgat tételt, csak azonos névre hozza', async () => {
    t = await createTestApp();
    const L = await setupLeaves(t);
    const tab = await openTab(t);
    await tab.commit(genSeries({ leaf: L.szoftver, section: 'out', name: 'Licenc', amount: 25_000, startYm: '2026-12', count: 1, rep: 'once', day: 3 }));
    const r = await t.post(`/api/leaves/${L.szoftver}/merge`, { into: L.minta });
    expect(r.data).toMatchObject({ ok: true, linked: true });
    const e = (await tab.reload()).entries[0];
    expect(e).toMatchObject({ leaf_id: L.szoftver, amount: -25_000 });
  });
});
