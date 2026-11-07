// Kuka (törölt tételek visszaállítása), változásnapló és visszavonás, partner-összevonás – a terv↔tény kötés megmaradása.
import { afterEach, describe, expect, it } from 'vitest';
import { createTestApp, type TestApp } from '../helpers/app';
import { openTab, setupLeaves } from '../helpers/adatok-client';
import { deleteEntries, genSeries, markDone } from '../../src/client/logic';

let t: TestApp | undefined;
afterEach(() => t?.close());

async function setup() {
  t = await createTestApp();
  const L = await setupLeaves(t);
  const tab = await openTab(t);
  return { app: t, L, tab };
}

const trash = async (app: TestApp) => (await app.get('/api/trash?offers=0')).data.items as { rid: number; id: string; kind: string }[];

describe('kuka', () => {
  it('kész terv visszaállítása a kukából: a vele együtt törölt ténye is visszajön, a kötés kétirányú marad', async () => {
    const { app, L, tab } = await setup();
    const b = genSeries({ leaf: L.minta, section: 'in', name: 'Arculat', amount: 640_000, startYm: '2026-10', count: 1, rep: 'once', day: 15 });
    await tab.commit(b);
    await tab.reload();
    const plan = tab.data.entries[0];
    await tab.commit(markDone(tab.data, [plan.id], true));
    const actId = tab.data.entries.find((e) => e.kind === 'actual')!.id;
    await tab.commit(deleteEntries(tab.data, [plan.id]));
    const items = await trash(app);
    expect(items).toHaveLength(2);
    // a felhasználó csak a tervet választja ki
    const r = await app.post('/api/trash/restore', { rids: [items.find((x) => x.id === plan.id)!.rid] });
    expect(r.status).toBe(200);
    const d = await tab.reload();
    expect(d.entries.find((e) => e.id === plan.id)).toMatchObject({ done: 1, link_id: actId });
    expect(d.entries.find((e) => e.id === actId)).toMatchObject({ kind: 'actual', amount: 640_000, link_id: plan.id });
    expect(await trash(app)).toHaveLength(0);
  });

  it('ha a terv ténye nincs meg (pl. véglegesen eltűnt), a visszaállított terv nyitott lesz', async () => {
    const { app, L, tab } = await setup();
    const now = Date.now();
    app.sql
      .prepare(
        `INSERT INTO deleted_entries (id, kind, date, leaf_id, name, amount, done, tentative, source, link_id, updated_at, updated_by, deleted_at, deleted_by)
         VALUES ('p9', 'plan', '2026-10-05', ?, 'Licenc', -45000, 1, 0, 'manual', 'nincs-ilyen', ?, 1, ?, 1)`,
      )
      .run(L.szoftver, now, now);
    const [row] = await trash(app);
    await app.post('/api/trash/restore', { rids: [row.rid] });
    expect((await tab.reload()).entries.find((e) => e.id === 'p9')).toMatchObject({ done: 0, link_id: null, amount: -45000 });
  });

  it('törölt tény visszaállítása: a (közben újranyitott) tervéhez újra kötődik', async () => {
    const { app, L, tab } = await setup();
    await tab.commit(genSeries({ leaf: L.iroda, section: 'out', name: 'Rezsi', amount: 85_000, startYm: '2026-10', count: 1, rep: 'once', day: 12 }));
    await tab.reload();
    const plan = tab.data.entries[0];
    await tab.commit(markDone(tab.data, [plan.id], true));
    const act = tab.data.entries.find((e) => e.kind === 'actual')!;
    await tab.commit(deleteEntries(tab.data, [act.id]));
    expect(tab.data.entries.find((e) => e.id === plan.id)).toMatchObject({ done: 0, link_id: null });
    const [row] = await trash(app);
    await app.post('/api/trash/restore', { rids: [row.rid] });
    const d = await tab.reload();
    expect(d.entries.find((e) => e.id === plan.id)).toMatchObject({ done: 1, link_id: act.id });
    expect(d.entries.find((e) => e.id === act.id)).toMatchObject({ link_id: plan.id });
  });

  it('a visszaállítás a változásnaplóból visszavonható (a tétel újra a kukába kerül)', async () => {
    const { app, L, tab } = await setup();
    await tab.commit(genSeries({ leaf: L.szoftver, section: 'out', name: 'Figma', amount: 15_000, startYm: '2026-12', count: 1, rep: 'once', day: 9 }));
    await tab.reload();
    const id = tab.data.entries[0].id;
    await tab.commit(deleteEntries(tab.data, [id]));
    const [row] = await trash(app);
    await app.post('/api/trash/restore', { rids: [row.rid] });
    const log = (await app.get('/api/changelog')).data.items as any[];
    const rest = log.find((x) => x.action === 'trash.restore');
    expect((await app.post(`/api/changelog/${rest.id}/undo`, {})).status).toBe(200);
    expect((await tab.reload()).entries).toHaveLength(0);
    expect((await trash(app)).map((x) => x.id)).toEqual([id]);
  });
});

describe('változásnapló visszavonás', () => {
  it('sorozat felvételének visszavonása: minden tétel a kukába, a sorozat törlődik', async () => {
    const { app, L, tab } = await setup();
    const b = genSeries({ leaf: L.ber, section: 'out', name: 'Munkabér', amount: 600_000, startYm: '2026-12', count: 3, rep: 'monthly', day: 10 });
    await tab.commit(b, '3 tétel felvéve');
    const log = (await app.get('/api/changelog')).data.items as any[];
    expect(log[0].summary).toContain('3 új');
    expect((await app.post(`/api/changelog/${log[0].id}/undo`, {})).status).toBe(200);
    const d = await tab.reload();
    expect(d.entries).toHaveLength(0);
    expect(d.series).toHaveLength(0);
    // a visszavonás is naplózva, kétszer nem vonható vissza
    expect((await app.post(`/api/changelog/${log[0].id}/undo`, {})).status).toBe(400);
  });

  it('összeg-módosítás visszavonása: pontosan a korábbi összeg és dátum', async () => {
    const { app, L, tab } = await setup();
    await tab.commit(genSeries({ leaf: L.iroda, section: 'out', name: 'Bérleti díj', amount: 380_000, startYm: '2026-12', count: 1, rep: 'once', day: 5 }));
    await tab.reload();
    const e = tab.data.entries[0];
    await tab.commit({ upsert: [{ ...e, amount: -420_000, date: '2026-12-08' }] }, 'Módosítva');
    const log = (await app.get('/api/changelog')).data.items as any[];
    expect((await app.post(`/api/changelog/${log[0].id}/undo`, {})).status).toBe(200);
    expect((await tab.reload()).entries[0]).toMatchObject({ amount: -380_000, date: '2026-12-05' });
  });

  it('sorozat-átnevezés visszavonása a naplóból: a sorozat és minden nyitott hónap visszakapja a régi nevet', async () => {
    const { app, L, tab } = await setup();
    const b = genSeries({ leaf: L.minta, section: 'in', name: 'Havi díj', amount: 250_000, startYm: '2026-11', count: 3, rep: 'monthly', day: 10 });
    await tab.commit(b);
    await tab.reload();
    const nov = tab.data.entries.find((e) => e.date === '2026-11-10')!;
    await tab.commit({ upsert: [{ ...nov, name: 'Marketing díj' }] }, 'Átnevezve');
    expect(app.sql.prepare('SELECT DISTINCT name FROM entries').all()).toEqual([{ name: 'Marketing díj' }]);
    const log = (await app.get('/api/changelog')).data.items as any[];
    expect((await app.post(`/api/changelog/${log[0].id}/undo`, {})).status).toBe(200);
    expect(app.sql.prepare('SELECT DISTINCT name FROM entries').all()).toEqual([{ name: 'Havi díj' }]);
    expect((app.sql.prepare('SELECT name FROM series').get() as any).name).toBe('Havi díj');
  });

  it('ha a tételt azóta újra módosították, a visszavonás rákérdez (409), kényszerítve felülírja', async () => {
    const { app, L, tab } = await setup();
    await tab.commit(genSeries({ leaf: L.iroda, section: 'out', name: 'Bérleti díj', amount: 380_000, startYm: '2026-12', count: 1, rep: 'once', day: 5 }));
    await tab.reload();
    const e = tab.data.entries[0];
    await tab.commit({ upsert: [{ ...e, amount: -420_000 }] }, 'első');
    const first = (await app.get('/api/changelog')).data.items[0];
    await tab.commit({ upsert: [{ ...tab.data.entries[0], amount: -430_000 }] }, 'második');
    expect((await app.post(`/api/changelog/${first.id}/undo`, {})).status).toBe(409);
    expect((await app.post(`/api/changelog/${first.id}/undo`, { force: true })).status).toBe(200);
    expect((await tab.reload()).entries[0].amount).toBe(-380_000);
  });
});

describe('partner-összevonás', () => {
  it('összevonás: tételek, sorozat és kötések átkerülnek, a forrás archivált; visszavonva minden visszaáll', async () => {
    const { app, L, tab } = await setup();
    const b = genSeries({ leaf: L.alfa, section: 'in', name: 'Havi díj', amount: 200_000, startYm: '2026-10', count: 3, rep: 'monthly', day: 10 });
    await tab.commit(b);
    await tab.reload();
    const okt = tab.data.entries.find((e) => e.date === '2026-10-10')!;
    await tab.commit(markDone(tab.data, [okt.id], true));
    expect((await app.post(`/api/leaves/${L.alfa}/merge`, { into: L.minta })).status).toBe(200);
    let d = await tab.reload();
    expect(d.entries.every((e) => e.leaf_id === L.minta)).toBe(true);
    expect(d.series[0].leaf_id).toBe(L.minta);
    expect(d.leaves.find((l) => l.id === L.alfa)!.archived).toBe(1);
    expect(d.entries.find((e) => e.id === okt.id)!.link_id).toBeTruthy();
    const log = (await app.get('/api/changelog')).data.items as any[];
    expect((await app.post(`/api/changelog/${log.find((x) => x.action === 'leaf.merge').id}/undo`, {})).status).toBe(200);
    d = await tab.reload();
    expect(d.entries.every((e) => e.leaf_id === L.alfa)).toBe(true);
    expect(d.leaves.find((l) => l.id === L.alfa)!.archived).toBe(0);
  });
});
