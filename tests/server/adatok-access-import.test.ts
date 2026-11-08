// Jogosultságok (olvasó / szerkesztő / admin), xls import (TÉNYEK / TERVEK), beállítások, fizetési szabály szerinti sorozat.
import { afterEach, describe, expect, it } from 'vitest';
import { createTestApp, type TestApp } from '../helpers/app';
import { openTab, setupLeaves } from '../helpers/adatok-client';
import { genSeries, payDefaults } from '../../src/client/logic';
import { groupId, leafId } from '../../src/shared/categories';
import { signCheckId, signMismatches } from '../../src/shared/flags';
import { buildIndex } from '../../src/shared/model';

let t: TestApp | undefined;
afterEach(() => t?.close());

const sampleEntry = (leaf: string) => ({
  id: 'e_jog_1',
  kind: 'plan',
  date: '2026-12-10',
  leaf_id: leaf,
  name: 'Próba',
  amount: 10_000,
  series_id: null,
  done: 0,
  tentative: 0,
  source: 'manual',
  ext_ref: null,
  link_id: null,
  note: null,
});

describe('jogosultság', () => {
  it('olvasó: lát mindent, de semmit sem írhat', async () => {
    t = await createTestApp();
    const L = await setupLeaves(t);
    await t.addUser('olvaso@minta.hu', 'viewer');
    await t.loginAs('olvaso@minta.hu');
    expect((await t.get('/api/data')).status).toBe(200);
    expect((await t.get('/api/trash')).status).toBe(200);
    expect((await t.get('/api/changelog')).status).toBe(200);
    const writes: [string, string, unknown][] = [
      ['POST', '/api/entries/batch', { upsert: [sampleEntry(L.minta)], expected: { e_jog_1: null } }],
      ['POST', '/api/leaves', { group_id: L.gin, label: 'Új Partner Kft.' }],
      ['PATCH', `/api/leaves/${L.minta}`, { archived: true }],
      ['PATCH', `/api/groups/${L.gin}`, { label: 'Átnevezve' }],
      ['POST', '/api/groups', { section: 'in', label: 'Új mappa' }],
      ['POST', `/api/leaves/${L.alfa}/merge`, { into: L.minta }],
      ['POST', '/api/trash/restore', { rids: [1] }],
      ['POST', '/api/changelog/1/undo', {}],
      ['POST', '/api/import', { kind: 'actual', rows: [] }],
      ['PUT', '/api/settings', { opening_balance: '0' }],
      ['POST', '/api/flags/ack', { ids: ['x'] }],
      ['POST', '/api/stats/refresh', {}],
      ['POST', '/api/users', { email: 'uj@minta.hu', role: 'admin' }],
      ['PUT', '/api/partners/minta-kft', { name: 'Minta' }],
      ['POST', '/api/rules', { pattern: 'minta', leaf_id: L.minta }],
    ];
    for (const [m, p, b] of writes) {
      const r = await t.call(m, p, b);
      expect([p, r.status]).toEqual([p, 403]);
    }
    expect(t.sql.prepare('SELECT count(*) AS n FROM entries').get()).toEqual({ n: 0 });
    expect((t.sql.prepare('SELECT label FROM groups WHERE id = ?').get(L.gin) as any).label).toBe('Projektek');
  });

  it('szerkesztő: tételt írhat, de importálni, beállítást és felhasználót módosítani nem', async () => {
    t = await createTestApp();
    const L = await setupLeaves(t);
    await t.addUser('szerk@minta.hu', 'member' as any);
    await t.loginAs('szerk@minta.hu');
    expect((await t.post('/api/entries/batch', { upsert: [sampleEntry(L.minta)], expected: { e_jog_1: null } })).status).toBe(200);
    expect((await t.post('/api/import', { kind: 'actual', rows: [] })).status).toBe(403);
    expect((await t.put('/api/settings', { opening_balance: '1000000' })).status).toBe(403);
    expect((await t.post('/api/users', { email: 'uj@minta.hu', role: 'admin' })).status).toBe(403);
    expect((await t.post('/api/stats/refresh', { all: true })).status).toBe(403);
  });

  it('a lefokozás azonnal hat a már bejelentkezett munkamenetre', async () => {
    t = await createTestApp();
    const L = await setupLeaves(t);
    const id = await t.addUser('szerk@minta.hu', 'member' as any);
    await t.loginAs('szerk@minta.hu');
    t.sql.prepare("UPDATE users SET role = 'viewer' WHERE id = ?").run(id);
    expect((await t.post('/api/entries/batch', { upsert: [sampleEntry(L.minta)], expected: { e_jog_1: null } })).status).toBe(403);
  });
});

describe('xls import', () => {
  const rows = [
    { date: 46300, name: 'Havi díj', category: 'Projektek - Minta Kft.', amount: 250_000 }, // Excel dátumszám: 2026-10-05
    { date: '2026. 10. 12.', name: 'Szerverbérlés', category: '3 Működési költségek - Szoftver, beszerzés', amount: -49_000 },
    { date: '2026-10-20', name: 'Alza visszatérítés', category: '3 Működési költségek - Iroda bérlés, rezsi', amount: 12_990 },
    { date: '2026-10-20', name: 'Nulla', category: '3 Működési költségek - Iroda bérlés, rezsi', amount: 0 },
    { date: '', name: 'Dátum nélkül', category: 'Projektek - Minta Kft.', amount: 5_000 },
  ];

  it('TÉNYEK: helyes hónap, kategória és előjel; a 0 Ft-os és dátum nélküli sor kimarad', async () => {
    t = await createTestApp();
    const r = await t.post('/api/import', { kind: 'actual', rows });
    expect(r.data).toMatchObject({ ok: true, imported: 3, skipped: 2 });
    const d = (await t.get('/api/data')).data;
    const by = (n: string) => d.entries.find((e: any) => e.name === n);
    const gin = groupId('in', 'Projektek');
    expect(by('Havi díj')).toMatchObject({ kind: 'actual', date: '2026-10-05', amount: 250_000, leaf_id: leafId(gin, 'Minta Kft.'), source: 'import' });
    expect(by('Szerverbérlés')).toMatchObject({ date: '2026-10-12', amount: -49_000 });
    // kiadás-kategóriában a pozitív összeg (visszatérítés) pozitív marad – az előjelet az xls adja
    expect(by('Alza visszatérítés').amount).toBe(12_990);
    expect(d.groups.find((g: any) => g.id === groupId('out', '3 Működési költségek')).section).toBe('out');
  });

  it('TÉNYEK újraimportálása nem duplikál, és a kézi átsorolást sem írja felül', async () => {
    t = await createTestApp();
    await t.post('/api/import', { kind: 'actual', rows });
    const id = (t.sql.prepare("SELECT id FROM entries WHERE name = 'Szerverbérlés'").get() as any).id;
    const other = leafId(groupId('out', '3 Működési költségek'), 'Iroda bérlés, rezsi');
    t.sql.prepare('UPDATE entries SET leaf_id = ? WHERE id = ?').run(other, id);
    await t.post('/api/import', { kind: 'actual', rows });
    expect(t.sql.prepare('SELECT count(*) AS n FROM entries').get()).toEqual({ n: 3 });
    expect((t.sql.prepare('SELECT leaf_id FROM entries WHERE id = ?').get(id) as any).leaf_id).toBe(other);
  });

  it('ugyanaz a sor kétszer a fájlban két külön tétel (két valós mozgás)', async () => {
    t = await createTestApp();
    const twice = [rows[1], rows[1]];
    await t.post('/api/import', { kind: 'actual', rows: twice });
    await t.post('/api/import', { kind: 'actual', rows: twice });
    expect(t.sql.prepare('SELECT count(*) AS n FROM entries').get()).toEqual({ n: 2 });
  });

  it('TERVEK cserével: a korábban importált nyitott tervek helyére az új fájl kerül, a teljesült megmarad és nem duplikálódik', async () => {
    t = await createTestApp();
    const plan1 = [
      { date: '2026-11-10', name: 'Bérleti díj', category: '3 Működési költségek - Iroda bérlés, rezsi', amount: -380_000 },
      { date: '2026-12-10', name: 'Bérleti díj', category: '3 Működési költségek - Iroda bérlés, rezsi', amount: -380_000 },
    ];
    await t.post('/api/import', { kind: 'plan', rows: plan1, replacePlans: true });
    const nov = t.sql.prepare("SELECT id FROM entries WHERE date = '2026-11-10'").get() as any;
    t.sql.prepare('UPDATE entries SET done = 1 WHERE id = ?').run(nov.id);
    const plan2 = [plan1[0], { ...plan1[1], amount: -395_000 }];
    await t.post('/api/import', { kind: 'plan', rows: plan2, replacePlans: true });
    const all = t.sql.prepare("SELECT date, amount, done FROM entries WHERE kind = 'plan' ORDER BY date").all();
    expect(all).toEqual([
      { date: '2026-11-10', amount: -380_000, done: 1 },
      { date: '2026-12-10', amount: -395_000, done: 0 },
    ]);
  });

  it('ajánlat sor (0 Ft, összeg a névben): bizonytalan bevételi terv az ügyfél nevű alkategóriában', async () => {
    t = await createTestApp();
    await t.post('/api/import', { kind: 'plan', rows: [{ date: '2026-12-01', name: 'Minta Kft. - SEO-448.000', category: 'Ajánlatok', amount: 0 }] });
    const e = t.sql.prepare('SELECT amount, tentative, name, leaf_id FROM entries').get() as any;
    expect(e).toMatchObject({ amount: 448_000, tentative: 1, name: 'Minta Kft. - SEO', leaf_id: leafId(groupId('in', 'Ajánlatok'), 'Minta Kft.') });
  });

  it.todo(
    'KÉRDÉS: a kukába tett (törölt) importált tény újraimportáláskor visszajöjjön-e? Most visszajön, mert az azonosító determinisztikus, és csak az élő tételekkel ütközik.',
  );
  it('TERVEK csere csak a fájl által lefedett hónapokat (legkorábbi–legkésőbbi hónap) cseréli: az előtte és utána lévő importált tervek megmaradnak', async () => {
    t = await createTestApp();
    const cat = '3 Működési költségek - Iroda bérlés, rezsi';
    const months = ['2026-11', '2026-12', '2027-01', '2027-02', '2027-03'];
    await t.post('/api/import', { kind: 'plan', rows: months.map((m) => ({ date: `${m}-10`, name: 'Bérleti díj', category: cat, amount: -380_000 })), replacePlans: true });
    // az új fájl csak 2 hónapot fed le (december közepétől január végéig), új összeggel
    const plan2 = [
      { date: '2026-12-15', name: 'Bérleti díj', category: cat, amount: -395_000 },
      { date: '2027-01-31', name: 'Bérleti díj', category: cat, amount: -395_000 },
    ];
    await t.post('/api/import', { kind: 'plan', rows: plan2, replacePlans: true });
    const all = t.sql.prepare("SELECT date, amount FROM entries WHERE kind = 'plan' ORDER BY date").all();
    expect(all).toEqual([
      { date: '2026-11-10', amount: -380_000 },
      // a december 10-i régi terv a lefedett hónapban van → cserélődik, akkor is, ha a fájl első dátuma később van
      { date: '2026-12-15', amount: -395_000 },
      { date: '2027-01-31', amount: -395_000 },
      { date: '2027-02-10', amount: -380_000 },
      { date: '2027-03-10', amount: -380_000 },
    ]);
  });
});

describe('beállítások és fizetési szabály', () => {
  it('csak admin módosíthatja; a fizetési határidő 0–180 nap közé szorul, ismeretlen kulcs nem íródik', async () => {
    t = await createTestApp();
    expect((await t.put('/api/settings', { default_pay_days: '15', default_pay_days_out: '30', data_rev: 'hack' })).status).toBe(200);
    const s = (await t.get('/api/data')).data.settings;
    expect(s.default_pay_days).toBe('15');
    expect(s.data_rev).not.toBe('hack');
    expect(payDefaults(s, 'out').payDays).toBe(30);
    expect(payDefaults(s, 'in').payDays).toBe(15);
    expect(payDefaults({ default_pay_days: '999' }).payDays).toBe(180);
  });

  it('„számlázás + 30 nap” szabályú havi sorozat: minden tétel a saját hónapja nevét viseli, nincs két „december”', async () => {
    t = await createTestApp();
    const L = await setupLeaves(t);
    await t.patch(`/api/leaves/${L.minta}`, { pay_rule: 'inv:30' });
    const tab = await openTab(t);
    const b = genSeries({ leaf: L.minta, section: 'in', name: 'Havi díj', amount: 250_000, startYm: '2026-11', count: 4, rep: 'monthly', day: 10, payRule: 'inv:30' });
    await tab.commit(b);
    const es = (await tab.reload()).entries.sort((a, c) => a.date.localeCompare(c.date));
    expect(es.map((e) => e.name)).toEqual(['Havi díj – 2026. november', 'Havi díj – 2026. december', 'Havi díj – 2027. január', 'Havi díj – 2027. február']);
    // a fizetés a szabály szerint a következő hónapra esik
    expect(es[0].date).toBe('2026-12-02');
  });
});

describe('előjel-ellenőrzés (gyanús előjelű tények)', () => {
  const tenyek = [
    { date: '2026-09-03', name: 'Felhő szoftver', category: '3 Működési költségek - Szoftver, beszerzés', amount: 176_000 }, // elírt előjel?
    { date: '2026-09-05', name: 'Bútorbolt visszatérítés', category: '3 Működési költségek - Iroda bérlés, rezsi', amount: 12_990 },
    { date: '2026-09-10', name: 'Irodabérlet', category: '3 Működési költségek - Iroda bérlés, rezsi', amount: -380_000 },
    { date: '2026-09-12', name: 'Havi díj', category: 'Projektek - Minta Kft.', amount: 250_000 },
    { date: '2026-09-20', name: 'Túlfizetés visszautalva', category: 'Projektek - Minta Kft.', amount: -40_000 },
  ];

  it('a pozitív kiadás- és negatív bevétel-tények listázódnak, a tervek nem; „Rendben” után eltűnnek, de a tétel nem változik', async () => {
    t = await createTestApp();
    await t.post('/api/import', { kind: 'actual', rows: tenyek });
    // negatív bevételi TERV nem tény → nem számít
    await t.post('/api/import', { kind: 'plan', rows: [{ date: '2026-12-10', name: 'Jóváírás', category: 'Projektek - Minta Kft.', amount: -10_000 }] });
    let d = (await t.get('/api/data')).data;
    const ix = buildIndex(d);
    const list = signMismatches(d.entries, ix.sectionOf, JSON.parse(d.settings.flags_ack || '[]'));
    expect(list.map((e) => [e.name, e.amount])).toEqual([
      ['Túlfizetés visszautalva', -40_000],
      ['Bútorbolt visszatérítés', 12_990],
      ['Felhő szoftver', 176_000],
    ]);
    // a visszatérítés átnézve: közös jelölés a beállításokban, a tétel összege érintetlen
    const refund = list.find((e) => e.name === 'Bútorbolt visszatérítés')!;
    expect((await t.post('/api/flags/ack', { ids: [signCheckId(refund)] })).status).toBe(200);
    d = (await t.get('/api/data')).data;
    const after = signMismatches(d.entries, buildIndex(d).sectionOf, JSON.parse(d.settings.flags_ack || '[]'));
    expect(after.map((e) => e.name)).toEqual(['Túlfizetés visszautalva', 'Felhő szoftver']);
    expect(d.entries.find((e: any) => e.id === refund.id).amount).toBe(12_990);
    // ha a tétel összegét később átírják, újra átnézendő
    t.sql.prepare('UPDATE entries SET amount = 13_990 WHERE id = ?').run(refund.id);
    d = (await t.get('/api/data')).data;
    expect(signMismatches(d.entries, buildIndex(d).sectionOf, JSON.parse(d.settings.flags_ack || '[]')).map((e) => e.name)).toContain('Bútorbolt visszatérítés');
  });
});
