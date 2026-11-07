// Tételek és ismétlődő sorozatok: létrehozás, szerkesztés, kész-jelölés, eltolás, meghosszabbítás, törlés – kliens-művelet → szerver → újratöltés.
import { afterEach, describe, expect, it } from 'vitest';
import { createTestApp, type TestApp } from '../helpers/app';
import { openTab, setupLeaves } from '../helpers/adatok-client';
import { deleteEntries, extendRows, genSeries, markDone, rowKey, setCellValue, shiftEntries } from '../../src/client/logic';
import type { DataBundle, Entry } from '../../src/shared/types';

let t: TestApp | undefined;
afterEach(() => t?.close());

const plansOf = (d: DataBundle, sid: string) => d.entries.filter((e) => e.series_id === sid && e.kind === 'plan').sort((a, b) => a.date.localeCompare(b.date));

async function setup() {
  t = await createTestApp();
  const L = await setupLeaves(t);
  const tab = await openTab(t);
  return { t, L, tab };
}

describe('sorozat létrehozása', () => {
  it('havi kiadás: 6 tétel, negatív előjel, egész forint, a név a hónappal jön vissza', async () => {
    const { L, tab } = await setup();
    const b = genSeries({ leaf: L.szoftver, section: 'out', name: 'Szerverbérlés', amount: 49_000, startYm: '2026-12', count: 6, rep: 'monthly', day: 15 });
    expect((await tab.commit(b)).status).toBe(200);
    const d = await tab.reload();
    const sid = b.series![0].id;
    const es = plansOf(d, sid);
    expect(es.map((e) => e.date)).toEqual(['2026-12-15', '2027-01-15', '2027-02-15', '2027-03-15', '2027-04-15', '2027-05-15']);
    expect(es.every((e) => e.amount === -49_000)).toBe(true);
    expect(es[0].name).toBe('Szerverbérlés – 2026. december');
    // tárolva az alapnév van, a hónap a period-ban
    const raw = t!.sql.prepare('SELECT name, period FROM entries WHERE series_id = ? ORDER BY date').all(sid) as any[];
    expect(raw[0]).toEqual({ name: 'Szerverbérlés', period: '2026-12' });
    expect(d.series.find((s) => s.id === sid)).toMatchObject({ leaf_id: L.szoftver, rep: 'monthly', day: 15 });
  });

  it('negyedéves bevétel 12 hónapra: 4 tétel, 3 havonta, pozitív', async () => {
    const { L, tab } = await setup();
    const b = genSeries({ leaf: L.minta, section: 'in', name: 'SEO csomag', amount: 450_000, startYm: '2027-01', count: 12, rep: 'quarterly', day: 31 });
    await tab.commit(b);
    const es = plansOf(await tab.reload(), b.series![0].id);
    expect(es.map((e) => e.date)).toEqual(['2027-01-31', '2027-04-30', '2027-07-31', '2027-10-31']);
    expect(es.every((e) => e.amount === 450_000)).toBe(true);
  });

  it('tizedes összeget a szerver elutasít (egész forint)', async () => {
    const { L, tab } = await setup();
    const b = genSeries({ leaf: L.szoftver, section: 'out', name: 'Licenc', amount: 12_500.5, startYm: '2026-12', count: 1, rep: 'once', day: 5 });
    expect((await tab.commit(b)).status).toBe(400);
    expect(t!.sql.prepare('SELECT count(*) AS n FROM entries').get()).toEqual({ n: 0 });
  });
});

describe('sorozat szerkesztése', () => {
  it('egy havi tétel összegének módosítása után a sorozat másik hónapja is szerkeszthető (nincs hamis ütközés)', async () => {
    const { L, tab } = await setup();
    const b = genSeries({ leaf: L.iroda, section: 'out', name: 'Irodabérlet', amount: 380_000, startYm: '2026-12', count: 3, rep: 'monthly', day: 5 });
    await tab.commit(b);
    await tab.reload();
    const [dec, jan] = plansOf(tab.data, b.series![0].id);
    expect((await tab.commit({ upsert: [{ ...dec, amount: -395_000 }] })).status).toBe(200);
    // ugyanabban a fülben, újratöltés nélkül (a store csak a módosított tétel verzióját kapja vissza)
    const jan2 = tab.data.entries.find((e) => e.id === jan.id)!;
    const r = await tab.commit({ upsert: [{ ...jan2, date: '2027-01-08' }] });
    expect(r.error).toBeUndefined();
    expect(r.status).toBe(200);
  });

  it('átnevezés egy tételen: a sorozat neve és minden nyitott hónapja átnevződik, a lezárt nem', async () => {
    const { L, tab } = await setup();
    const b = genSeries({ leaf: L.minta, section: 'in', name: 'Havi díj', amount: 250_000, startYm: '2026-10', count: 3, rep: 'monthly', day: 10 });
    await tab.commit(b);
    await tab.reload();
    const sid = b.series![0].id;
    const [okt] = plansOf(tab.data, sid);
    await tab.commit(markDone(tab.data, [okt.id], true));
    const nov = plansOf(tab.data, sid)[1];
    await tab.commit({ upsert: [{ ...nov, name: 'Havi díj (SEO) – 2026. november' }] });
    const d = await tab.reload();
    const es = plansOf(d, sid);
    expect(es.map((e) => e.name)).toEqual(['Havi díj – 2026. október', 'Havi díj (SEO) – 2026. november', 'Havi díj (SEO) – 2026. december']);
    expect(d.series.find((s) => s.id === sid)!.name).toBe('Havi díj (SEO)');
  });

  it('a szerkesztő (EntryModal) mentése: minden nyitott tétel új összeget kap, a lezártak összege marad', async () => {
    const { L, tab } = await setup();
    const b = genSeries({ leaf: L.ber, section: 'out', name: 'Munkabér', amount: 600_000, startYm: '2026-10', count: 4, rep: 'monthly', day: 10 });
    await tab.commit(b);
    await tab.reload();
    const sid = b.series![0].id;
    await tab.commit(markDone(tab.data, [plansOf(tab.data, sid)[0].id], true));
    const rows = tab.data.entries.filter((e) => e.kind === 'plan' && rowKey(e) === sid);
    const series = tab.data.series.find((s) => s.id === sid)!;
    const upsert: Entry[] = rows.filter((e) => !e.done).map((e) => ({ ...e, name: 'Munkabér', amount: -650_000 }));
    rows.filter((e) => e.done).forEach((e) => upsert.push({ ...e, name: 'Munkabér' }));
    expect((await tab.commit({ upsert, series: [{ ...series, name: 'Munkabér' }] })).status).toBe(200);
    const es = plansOf(await tab.reload(), sid);
    expect(es.map((e) => e.amount)).toEqual([-600_000, -650_000, -650_000, -650_000]);
    expect(es.filter((e) => e.kind === 'plan')).toHaveLength(4);
    // a lezárt hónap ténye megmaradt és kötve van
    const done = es[0];
    const act = tab.data.entries.find((e) => e.id === done.link_id)!;
    expect(act).toMatchObject({ kind: 'actual', amount: -600_000, link_id: done.id });
  });

  it('az „ütközés” valódi: másik fül közbeni módosítása után a régi verzióval küldött mentés 409, és semmi sem íródik', async () => {
    const { t: app, L, tab } = await setup();
    const b = genSeries({ leaf: L.szoftver, section: 'out', name: 'Adobe', amount: 25_000, startYm: '2026-12', count: 2, rep: 'monthly', day: 3 });
    await tab.commit(b);
    await tab.reload();
    const other = await openTab(app);
    const [e1, e2] = plansOf(other.data, b.series![0].id);
    expect((await other.commit({ upsert: [{ ...e1, amount: -27_000 }] })).status).toBe(200);
    const [s1, s2] = plansOf(tab.data, b.series![0].id);
    const r = await tab.commit({ upsert: [{ ...s1, amount: -30_000 }, { ...s2, amount: -30_000 }] });
    expect(r.status).toBe(409);
    expect(plansOf(await tab.reload(), b.series![0].id).map((e) => e.amount)).toEqual([-27_000, -25_000]);
    void e2;
  });
});

describe('kész-jelölés', () => {
  it('kész: kézi tény jön létre kétirányú kötéssel; visszanyitás: a tény a kukába kerül, a terv nyitott', async () => {
    const { L, tab } = await setup();
    const b = genSeries({ leaf: L.minta, section: 'in', name: 'Weboldal', amount: 1_200_000, startYm: '2026-10', count: 1, rep: 'once', day: 20 });
    await tab.commit(b);
    await tab.reload();
    const plan = tab.data.entries.find((e) => e.kind === 'plan')!;
    await tab.commit(markDone(tab.data, [plan.id], true));
    let d = await tab.reload();
    const p = d.entries.find((e) => e.id === plan.id)!;
    const a = d.entries.find((e) => e.id === p.link_id)!;
    expect(p.done).toBe(1);
    expect(a).toMatchObject({ kind: 'actual', amount: 1_200_000, link_id: plan.id, source: 'manual', date: '2026-10-20' });
    await tab.commit(markDone(d, [plan.id], false));
    d = await tab.reload();
    expect(d.entries.find((e) => e.id === plan.id)).toMatchObject({ done: 0, link_id: null });
    expect(d.entries.filter((e) => e.kind === 'actual')).toHaveLength(0);
  });

  it('a kész-jelölés visszavonása (toast) pontosan visszaállít: nincs árva tény, a terv nyitott', async () => {
    const { L, tab } = await setup();
    const b = genSeries({ leaf: L.szoftver, section: 'out', name: 'Könyvelés', amount: 90_000, startYm: '2026-10', count: 2, rep: 'monthly', day: 10 });
    await tab.commit(b);
    await tab.reload();
    const [okt] = plansOf(tab.data, b.series![0].id);
    const r = await tab.commit(markDone(tab.data, [okt.id], true));
    expect((await r.undo()).status).toBe(200);
    const d = await tab.reload();
    expect(d.entries.filter((e) => e.kind === 'actual')).toHaveLength(0);
    expect(d.entries.find((e) => e.id === okt.id)).toMatchObject({ done: 0, link_id: null, amount: -90_000 });
  });

  it('a kész-jelölés visszavonása a változásnaplóból: a tény eltűnik, a terv nyitott', async () => {
    const { t: app, L, tab } = await setup();
    const b = genSeries({ leaf: L.szoftver, section: 'out', name: 'Könyvelés', amount: 90_000, startYm: '2026-10', count: 1, rep: 'once', day: 10 });
    await tab.commit(b);
    await tab.reload();
    const plan = tab.data.entries[0];
    await tab.commit(markDone(tab.data, [plan.id], true), 'Kész ✓');
    const log = (await app.get('/api/changelog')).data.items as any[];
    const last = log.find((x) => x.summary.startsWith('Kész'));
    expect((await app.post(`/api/changelog/${last.id}/undo`, {})).status).toBe(200);
    const d = await tab.reload();
    expect(d.entries.filter((e) => e.kind === 'actual')).toHaveLength(0);
    expect(d.entries.find((e) => e.id === plan.id)).toMatchObject({ done: 0, link_id: null });
  });
});

describe('törlés', () => {
  it('kész terv törlése: a kézi tény is törlődik, mindkettő a kukába kerül', async () => {
    const { t: app, L, tab } = await setup();
    const b = genSeries({ leaf: L.minta, section: 'in', name: 'Kampány', amount: 300_000, startYm: '2026-10', count: 1, rep: 'once', day: 5 });
    await tab.commit(b);
    await tab.reload();
    const plan = tab.data.entries[0];
    await tab.commit(markDone(tab.data, [plan.id], true));
    await tab.commit(deleteEntries(tab.data, [plan.id]));
    const d = await tab.reload();
    expect(d.entries).toHaveLength(0);
    expect((app.sql.prepare('SELECT count(*) AS n FROM deleted_entries').get() as any).n).toBe(2);
  });

  it('tervhez kötött tény törlése: a terv újra nyitott lesz (nem marad „teljesült” tény nélkül)', async () => {
    const { L, tab } = await setup();
    const b = genSeries({ leaf: L.iroda, section: 'out', name: 'Rezsi', amount: 85_000, startYm: '2026-10', count: 1, rep: 'once', day: 12 });
    await tab.commit(b);
    await tab.reload();
    const plan = tab.data.entries[0];
    await tab.commit(markDone(tab.data, [plan.id], true));
    const act = tab.data.entries.find((e) => e.kind === 'actual')!;
    // a kategória nézet tény-listájának × gombja
    await tab.commit(deleteEntries(tab.data, [act.id]));
    const d = await tab.reload();
    expect(d.entries.find((e) => e.id === plan.id)).toMatchObject({ done: 0, link_id: null });
  });

  it('banki ténnyel teljesült terv törlése: a banki tény megmarad, de már nem mutat a törölt tervre', async () => {
    const { t: app, L, tab } = await setup();
    const now = Date.now();
    app.sql
      .prepare(
        `INSERT INTO entries (id, kind, date, leaf_id, name, amount, done, tentative, source, link_id, updated_at, updated_by) VALUES
         ('p1', 'plan', '2026-10-05', ?, 'Rezsi', -85000, 1, 0, 'manual', 'a1', ?, 1),
         ('a1', 'actual', '2026-10-06', ?, 'ELMŰ', -85000, 0, 0, 'bank', 'p1', ?, 1)`,
      )
      .run(L.iroda, now, L.iroda, now);
    await tab.reload();
    await tab.commit(deleteEntries(tab.data, ['p1']));
    const d = await tab.reload();
    expect(d.entries.find((e) => e.id === 'a1')).toMatchObject({ kind: 'actual', amount: -85000, link_id: null });
  });

  it('a sorozat (EntryModal) törlése: a nyitott hónapok törlődnek, a lezárt hónap és a ténye marad', async () => {
    const { L, tab } = await setup();
    const b = genSeries({ leaf: L.ber, section: 'out', name: 'Munkabér', amount: 600_000, startYm: '2026-10', count: 3, rep: 'monthly', day: 10 });
    await tab.commit(b);
    await tab.reload();
    const sid = b.series![0].id;
    await tab.commit(markDone(tab.data, [plansOf(tab.data, sid)[0].id], true));
    const rows = tab.data.entries.filter((e) => e.kind === 'plan' && rowKey(e) === sid);
    await tab.commit({ delete: rows.filter((e) => !e.done).map((e) => e.id) });
    const d = await tab.reload();
    expect(plansOf(d, sid)).toHaveLength(1);
    expect(d.entries.filter((e) => e.kind === 'actual')).toHaveLength(1);
  });

  it('törlés visszavonása (toast) a link_id-t is visszaadja', async () => {
    const { L, tab } = await setup();
    const b = genSeries({ leaf: L.minta, section: 'in', name: 'Kampány', amount: 300_000, startYm: '2026-10', count: 1, rep: 'once', day: 5 });
    await tab.commit(b);
    await tab.reload();
    const plan = tab.data.entries[0];
    await tab.commit(markDone(tab.data, [plan.id], true));
    const act = tab.data.entries.find((e) => e.kind === 'actual')!;
    const r = await tab.commit(deleteEntries(tab.data, [plan.id]));
    expect((await r.undo()).status).toBe(200);
    const d = await tab.reload();
    expect(d.entries.find((e) => e.id === plan.id)).toMatchObject({ done: 1, link_id: act.id });
    expect(d.entries.find((e) => e.id === act.id)).toMatchObject({ link_id: plan.id });
    // a visszaállított tételek kikerültek a kukából
    expect((t!.sql.prepare('SELECT count(*) AS n FROM deleted_entries').get() as any).n).toBe(0);
    // újbóli törlés után a kukában tételenként egy sor látszik
    await tab.commit(deleteEntries(tab.data, [plan.id]));
    const trash = (await t!.get('/api/trash?offers=0')).data.items as any[];
    expect(trash.map((x) => x.id).sort()).toEqual([act.id, plan.id].sort());
  });
});

describe('eltolás és meghosszabbítás', () => {
  it('eltolás +1 hónap: a lezárt tétel nem mozdul, hónap végén a rövidebb hónap utolsó napjára kerül', async () => {
    const { L, tab } = await setup();
    const b = genSeries({ leaf: L.szoftver, section: 'out', name: 'Tárhely', amount: 9_000, startYm: '2026-10', count: 4, rep: 'monthly', day: 31 });
    await tab.commit(b);
    await tab.reload();
    const sid = b.series![0].id;
    const es = plansOf(tab.data, sid);
    await tab.commit(markDone(tab.data, [es[0].id], true));
    await tab.commit(
      shiftEntries(
        tab.data,
        es.map((e) => e.id),
        1,
      ),
    );
    const after = plansOf(await tab.reload(), sid);
    expect(after.map((e) => e.date)).toEqual(['2026-10-31', '2026-12-30', '2027-01-31', '2027-02-28']);
  });

  it('meghosszabbítás: a sorozat az utolsó tétel után folytatódik, ugyanabban a sorozatban, duplikátum nélkül', async () => {
    const { L, tab } = await setup();
    const b = genSeries({ leaf: L.minta, section: 'in', name: 'Havi díj', amount: 250_000, startYm: '2026-11', count: 3, rep: 'monthly', day: 10 });
    await tab.commit(b);
    await tab.reload();
    const sid = b.series![0].id;
    const last = plansOf(tab.data, sid)[2];
    await tab.commit(extendRows(tab.data, [last.id], 3));
    let es = plansOf(await tab.reload(), sid);
    expect(es.map((e) => e.date)).toEqual(['2026-11-10', '2026-12-10', '2027-01-10', '2027-02-10', '2027-03-10', '2027-04-10']);
    expect(new Set(es.map((e) => e.date.slice(0, 7))).size).toBe(6);
    expect(es.map((e) => e.name)[5]).toBe('Havi díj – 2027. április');
    // a hónap (period) a dátumból jön, nem öröklődik
    expect(t!.sql.prepare('SELECT period FROM entries WHERE id = ?').get(es[5].id)).toEqual({ period: '2027-04' });
    // kétszeri meghosszabbítás sem duplikál
    await tab.commit(extendRows(tab.data, [es[0].id], 1));
    es = plansOf(await tab.reload(), sid);
    expect(es).toHaveLength(7);
    expect(new Set(es.map((e) => e.date.slice(0, 7))).size).toBe(7);
  });

  it('negyedéves sorozat meghosszabbítása 3 hónappal: egy új tétel, 3 hónap múlva', async () => {
    const { L, tab } = await setup();
    const b = genSeries({ leaf: L.minta, section: 'in', name: 'Audit', amount: 800_000, startYm: '2026-12', count: 6, rep: 'quarterly', day: 15 });
    await tab.commit(b);
    await tab.reload();
    const sid = b.series![0].id;
    await tab.commit(extendRows(tab.data, [plansOf(tab.data, sid)[0].id], 3));
    expect(plansOf(await tab.reload(), sid).map((e) => e.date)).toEqual(['2026-12-15', '2027-03-15', '2027-06-15']);
  });

  it('kész tétel utáni meghosszabbítás: az új hónap nyitott és nincs kötve a régi tényhez', async () => {
    const { L, tab } = await setup();
    const b = genSeries({ leaf: L.minta, section: 'in', name: 'Support', amount: 120_000, startYm: '2026-10', count: 1, rep: 'monthly', day: 10 });
    await tab.commit(b);
    await tab.reload();
    const [okt] = plansOf(tab.data, b.series![0].id);
    await tab.commit(markDone(tab.data, [okt.id], true));
    await tab.commit(extendRows(tab.data, [okt.id], 1));
    const es = plansOf(await tab.reload(), b.series![0].id);
    expect(es[1]).toMatchObject({ date: '2026-11-10', done: 0, link_id: null, amount: 120_000 });
  });
});

describe('áttekintő cella átírása (setCellValue)', () => {
  it('a hónap tervösszege a kívánt értékre áll (kiadásnál negatív tárolással), ajánlat nem számít bele', async () => {
    const { L, tab } = await setup();
    await tab.commit(genSeries({ leaf: L.szoftver, section: 'out', name: 'Adobe', amount: 25_000, startYm: '2026-12', count: 1, rep: 'once', day: 3 }));
    await tab.commit(genSeries({ leaf: L.szoftver, section: 'out', name: 'Figma', amount: 15_000, startYm: '2026-12', count: 1, rep: 'once', day: 9 }));
    await tab.reload();
    const b = setCellValue(tab.data, L.szoftver, 'out', '2026-12', 50_000)!;
    await tab.commit(b);
    const d = await tab.reload();
    const sum = d.entries.filter((e) => e.leaf_id === L.szoftver && e.date.startsWith('2026-12')).reduce((s, e) => s + e.amount, 0);
    expect(sum).toBe(-50_000);
  });
});
