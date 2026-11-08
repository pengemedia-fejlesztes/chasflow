// Író végpontok: tétel-batch hibaágai, kategóriák (levél / mappa), munkatársak és munkaidő, beállítások,
// riasztás-nyugtázás, import- és napló-hibaágak, kuka-idempotencia. A valódi backend ellen; az írást t.sql-lel
// és a /api/data visszaolvasásával is ellenőrizzük, a hibás kérés után pedig azt, hogy semmi sem változott.
import { afterEach, describe, expect, it } from 'vitest';
import { createTestApp, type TestApp } from '../helpers/app';
import { openTab, setupLeaves } from '../helpers/adatok-client';
import { deleteEntries, genSeries } from '../../src/client/logic';

let t: TestApp | undefined;
afterEach(() => {
  t?.close();
  t = undefined;
});

const rows = (sql: string, ...args: any[]) => t!.sql.prepare(sql).all(...args) as any[];
const row = (sql: string, ...args: any[]) => t!.sql.prepare(sql).get(...args) as any;
const n = (table: string) => row(`SELECT count(*) AS n FROM ${table}`).n as number;
const data = async () => (await t!.get('/api/data')).data;

const plan = (id: string, leaf: string, extra: Record<string, unknown> = {}) => ({
  id,
  kind: 'plan',
  date: '2026-12-10',
  leaf_id: leaf,
  name: 'Havi díj',
  amount: 150_000,
  series_id: null,
  done: 0,
  tentative: 0,
  source: 'manual',
  ext_ref: null,
  link_id: null,
  note: null,
  ...extra,
});

async function asRole(role: 'member' | 'viewer') {
  const email = role === 'member' ? 'szerk@minta.hu' : 'olvaso@minta.hu';
  await t!.addUser(email, role);
  await t!.loginAs(email);
}

describe('tételek (POST /api/entries/batch) – hibás bemenet, idempotencia', () => {
  it('nem létező kategória: érthető 400, és a batch többi (helyes) tétele sem íródik be', async () => {
    t = await createTestApp();
    const L = await setupLeaves(t);
    const r = await t.post('/api/entries/batch', {
      upsert: [plan('e_ok', L.minta), plan('e_rossz', 'l_nincs_ilyen')],
      expected: { e_ok: null, e_rossz: null },
    });
    expect(r.status).toBe(400);
    expect(r.data.error).toMatch(/Ismeretlen kategória/);
    expect(n('entries')).toBe(0);
    expect(n('change_log')).toBe(0);
    // sorozat nem létező kategóriában ugyanígy
    const s = await t.post('/api/entries/batch', {
      upsert: [plan('e_ok', L.minta, { series_id: 's1' })],
      series: [{ id: 's1', leaf_id: 'l_nincs_ilyen', name: 'Havi díj', rep: 'monthly', day: 10 }],
      expected: { e_ok: null },
      expectedSeries: { s1: null },
    });
    expect(s.status).toBe(400);
    expect(n('entries') + n('series')).toBe(0);
  });

  it('tört / szöveges összeg, hibás dátum: 400, semmi nem íródik', async () => {
    t = await createTestApp();
    const L = await setupLeaves(t);
    for (const bad of [{ amount: 1500.5 }, { amount: '12 500' }, { date: '2026.12.10' }, { kind: 'egyéb' }]) {
      const r = await t.post('/api/entries/batch', { upsert: [plan('e_ok', L.minta), plan('e_x', L.minta, bad)], expected: { e_ok: null, e_x: null } });
      expect([bad, r.status]).toEqual([bad, 400]);
    }
    expect(n('entries')).toBe(0);
  });

  it('ugyanaz az új tétel kétszer beküldve (dupla kattintás / újraküldés): a második 409, nincs duplikátum', async () => {
    t = await createTestApp();
    const L = await setupLeaves(t);
    const body = { upsert: [plan('e_dupla', L.minta)], expected: { e_dupla: null }, label: 'Új tétel' };
    expect((await t.post('/api/entries/batch', body)).status).toBe(200);
    const again = await t.post('/api/entries/batch', body);
    expect(again.status).toBe(409);
    expect(rows('SELECT id, amount FROM entries')).toEqual([{ id: 'e_dupla', amount: 150_000 }]);
    expect(n('change_log')).toBe(1);
    expect((await data()).entries.map((e: any) => e.id)).toEqual(['e_dupla']);
  });
});

describe('alkategória (PATCH /api/leaves/:id)', () => {
  it('üres név: 400 és a név marad; hibás fizetési szabály / határidő: 400 és a meglévő szabály marad', async () => {
    t = await createTestApp();
    const L = await setupLeaves(t);
    expect((await t.patch(`/api/leaves/${L.minta}`, { pay_rule: 'inv:15', pay_days: 15 })).status).toBe(200);
    const logs = n('change_log');

    const empty = await t.patch(`/api/leaves/${L.minta}`, { label: '   ' });
    expect(empty.status).toBe(400);
    expect(empty.data.error).toBe('Adj meg nevet.');
    for (const bad of [
      { pay_rule: 'minden kedden' },
      { pay_rule: 'day:45' },
      { pay_days: 'harminc' },
      { pay_days: 400 },
      { label: 'Új név', pay_rule: 'xx' },
    ]) {
      const r = await t.patch(`/api/leaves/${L.minta}`, bad);
      expect([bad, r.status]).toEqual([bad, 400]);
    }
    expect(row('SELECT label, pay_rule, pay_days FROM leaves WHERE id = ?', L.minta)).toEqual({ label: 'Minta Kft.', pay_rule: 'inv:15', pay_days: 15 });
    expect(n('change_log')).toBe(logs);

    // a szabály törlése (üres) megengedett, és a /api/data is ezt mutatja
    expect((await t.patch(`/api/leaves/${L.minta}`, { pay_rule: '', pay_days: null })).status).toBe(200);
    expect((await data()).leaves.find((l: any) => l.id === L.minta)).toMatchObject({ pay_rule: null, pay_days: null });
  });
});

describe('mappa (POST /api/groups, PATCH /api/groups/:id)', () => {
  it('felvétel: ugyanaz a név kétszer egy mappa; csak admin', async () => {
    t = await createTestApp();
    const a = await t.post('/api/groups', { section: 'out', label: 'Marketing' });
    const b = await t.post('/api/groups', { section: 'out', label: 'Marketing' });
    expect(a.status).toBe(200);
    expect(b.data.id).toBe(a.data.id);
    expect(rows("SELECT section, label FROM groups WHERE label = 'Marketing'")).toEqual([{ section: 'out', label: 'Marketing' }]);
    await asRole('member');
    expect((await t.post('/api/groups', { section: 'out', label: 'Rendezvények' })).status).toBe(403);
    expect(n('groups')).toBe(1);
  });

  it('átnevezés és fizetési szabály (szerkesztő is); ismeretlen mappa 404, üres név / hibás szabály 400 – részleges írás nélkül', async () => {
    t = await createTestApp();
    const L = await setupLeaves(t);
    await asRole('member');
    expect((await t.patch(`/api/groups/${L.gout}`, { label: '3 Működés', pay_rule: 'day:10' })).status).toBe(200);
    expect((await data()).groups.find((g: any) => g.id === L.gout)).toMatchObject({ label: '3 Működés', pay_rule: 'day:10' });

    const unknown = await t.patch('/api/groups/g_nincs', { label: 'Valami' });
    expect(unknown.status).toBe(404);
    expect(n('groups')).toBe(3);
    expect((await t.patch(`/api/groups/${L.gout}`, { label: '' })).status).toBe(400);
    const mixed = await t.patch(`/api/groups/${L.gout}`, { label: 'Másik név', pay_rule: 'hetente' });
    expect(mixed.status).toBe(400);
    expect(mixed.data.error).toBe('Hibás fizetési szabály.');
    expect(row('SELECT label, pay_rule FROM groups WHERE id = ?', L.gout)).toEqual({ label: '3 Működés', pay_rule: 'day:10' });
  });
});

describe('összevonás (POST /api/leaves/:id/merge) – hibaágak', () => {
  it('önmagába / nem létezőbe: 400 / 404, semmi sem mozdul', async () => {
    t = await createTestApp();
    const L = await setupLeaves(t);
    await t.post('/api/entries/batch', { upsert: [plan('e1', L.minta)], expected: { e1: null } });
    expect((await t.post(`/api/leaves/${L.minta}/merge`, { into: L.minta })).status).toBe(400);
    expect((await t.post(`/api/leaves/${L.minta}/merge`, {})).status).toBe(400);
    expect((await t.post(`/api/leaves/${L.minta}/merge`, { into: 'l_nincs' })).status).toBe(404);
    expect(row('SELECT leaf_id FROM entries WHERE id = ?', 'e1').leaf_id).toBe(L.minta);
    expect(row('SELECT archived FROM leaves WHERE id = ?', L.minta).archived).toBe(0);
    expect(n('partner_rules')).toBe(0);
  });
});

describe('munkatársak (PUT /api/employees) és munkaidő (POST /api/worktime/import)', () => {
  const SHEET = 'https://docs.google.com/spreadsheets/d/1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789/edit';

  it('felvétel, módosítás (a link csak akkor változik, ha a kérés hozza), törlés üres linkkel; hibás adat 400', async () => {
    t = await createTestApp();
    const L = await setupLeaves(t);
    const r = await t.put('/api/employees', { name: 'Kovács Anna', cost_leaf_id: L.ber, sheet_url: SHEET });
    expect(r.status).toBe(200);
    const key = r.data.key;
    expect((await data()).employees).toEqual([{ key, name: 'Kovács Anna', cost_leaf_id: L.ber, sheet_url: SHEET }]);

    expect((await t.put('/api/employees', { key, name: 'Kovács Anna Mária', cost_leaf_id: L.ber })).status).toBe(200);
    expect(row('SELECT name, sheet_url FROM employees WHERE key = ?', key)).toEqual({ name: 'Kovács Anna Mária', sheet_url: SHEET });
    expect((await t.put('/api/employees', { key, name: 'Kovács Anna Mária', cost_leaf_id: L.ber, sheet_url: '' })).status).toBe(200);
    expect(row('SELECT sheet_url FROM employees WHERE key = ?', key).sheet_url).toBeNull();

    const badUrl = await t.put('/api/employees', { key, name: 'Kovács Anna', cost_leaf_id: L.ber, sheet_url: 'https://example.com/tabla.xlsx' });
    expect(badUrl.status).toBe(400);
    expect(badUrl.data.error).toMatch(/Google-táblázat/);
    const badLeaf = await t.put('/api/employees', { key, name: 'Kovács Anna', cost_leaf_id: 'l_nincs' });
    expect(badLeaf.status).toBe(400);
    expect(badLeaf.data.error).toBe('Ismeretlen alkategória.');
    expect((await t.put('/api/employees', { name: '  ' })).status).toBe(400);
    expect(rows('SELECT name, cost_leaf_id FROM employees')).toEqual([{ name: 'Kovács Anna Mária', cost_leaf_id: L.ber }]);
  });

  it('munkaidő: a feltöltött hónapok felülíródnak, a többi hónap / munkatárs marad; azonos projekt+címke összeadódik', async () => {
    t = await createTestApp();
    const L = await setupLeaves(t);
    const anna = (await t.put('/api/employees', { name: 'Kovács Anna', cost_leaf_id: L.ber })).data.key;
    const bela = (await t.put('/api/employees', { name: 'Szabó Béla', cost_leaf_id: L.ber })).data.key;
    await t.post('/api/worktime/import', { employee: bela, rows: [{ ym: '2026-10', project: 'Minta Kft.', tag: 'SEO', minutes: 300, eur: 50 }] });
    const first = await t.post('/api/worktime/import', {
      employee: anna,
      rows: [
        { ym: '2026-09', project: 'Minta Kft.', tag: 'SEO', minutes: 600, eur: 120 },
        { ym: '2026-10', project: 'Minta Kft.', tag: 'SEO', minutes: 240, eur: 40.255 },
        { ym: '2026-10', project: 'Minta Kft.', tag: 'SEO', minutes: 60, eur: 10 },
        { ym: '2026-10', project: 'Alfa Bt.', tag: '', minutes: 90 },
        { ym: '2026/10', project: 'Rossz hónap', tag: '', minutes: 30 },
        { ym: '2026-10', project: 'Nulla perc', tag: '', minutes: 0 },
      ],
    });
    expect(first.data).toEqual({ ok: true, months: 2, rows: 4 });
    expect(rows('SELECT ym, project, tag, minutes, eur FROM worktime WHERE employee = ? ORDER BY ym, project', anna)).toEqual([
      { ym: '2026-09', project: 'Minta Kft.', tag: 'SEO', minutes: 600, eur: 120 },
      { ym: '2026-10', project: 'Alfa Bt.', tag: '', minutes: 90, eur: 0 },
      { ym: '2026-10', project: 'Minta Kft.', tag: 'SEO', minutes: 300, eur: 50.26 },
    ]);
    // októberi javított tábla: csak október cserélődik, szeptember és Béla marad
    await t.post('/api/worktime/import', { employee: anna, rows: [{ ym: '2026-10', project: 'Minta Kft.', tag: 'SEO', minutes: 120, eur: 20 }] });
    const wt = (await data()).worktime as any[];
    expect(wt.filter((w) => w.employee === anna).map((w) => [w.ym, w.project, w.minutes])).toEqual([
      ['2026-09', 'Minta Kft.', 600],
      ['2026-10', 'Minta Kft.', 120],
    ]);
    expect(wt.filter((w) => w.employee === bela)).toHaveLength(1);
    // ugyanaz a fájl kétszer: nem duplikál
    await t.post('/api/worktime/import', { employee: anna, rows: [{ ym: '2026-10', project: 'Minta Kft.', tag: 'SEO', minutes: 120, eur: 20 }] });
    expect(row("SELECT minutes FROM worktime WHERE employee = ? AND ym = '2026-10'", anna).minutes).toBe(120);

    const unknown = await t.post('/api/worktime/import', { employee: 'nincs', rows: [{ ym: '2026-10', project: 'X', minutes: 10 }] });
    expect(unknown.status).toBe(400);
    expect(unknown.data.error).toBe('Ismeretlen munkatárs.');
    expect(n('worktime')).toBe(3);
  });

  it('szerkesztő és olvasó: 403 a munkatárs- és munkaidő-végponton', async () => {
    t = await createTestApp();
    const L = await setupLeaves(t);
    const key = (await t.put('/api/employees', { name: 'Kovács Anna', cost_leaf_id: L.ber })).data.key;
    for (const role of ['member', 'viewer'] as const) {
      await asRole(role);
      expect((await t.put('/api/employees', { key, name: 'Átírva' })).status).toBe(403);
      expect((await t.post('/api/worktime/import', { employee: key, rows: [{ ym: '2026-10', project: 'X', minutes: 10 }] })).status).toBe(403);
      expect((await t.post('/api/worktime/fetch', { employee: key })).status).toBe(403);
      await t.loginAs('admin@teszt.hu');
    }
    expect(rows('SELECT name FROM employees')).toEqual([{ name: 'Kovács Anna' }]);
    expect(n('worktime')).toBe(0);
  });
});

describe('beállítások (PUT /api/settings) – értékek ellenőrzése', () => {
  it('helyes értékek mentése és visszaolvasása; üres érték törli', async () => {
    t = await createTestApp();
    const L = await setupLeaves(t);
    const r = await t.put('/api/settings', {
      opening_balance: '-250000',
      profit_target: '1500000',
      default_pay_days_in: '8',
      default_pay_days_out: '',
      billingo_leaf_default: L.minta,
    });
    expect(r.status).toBe(200);
    const s = (await data()).settings;
    expect(s).toMatchObject({
      opening_balance: '-250000',
      profit_target: '1500000',
      default_pay_days_in: '8',
      default_pay_days_out: '',
      billingo_leaf_default: L.minta,
    });
    expect((await t.put('/api/settings', { profit_target: null })).status).toBe(200);
    // törölve: a válaszban nem szerepel (a szerver csak a beállított értékeket adja ki)
    expect((await data()).settings.profit_target ?? null).toBeNull();
  });

  it('szöveges összeg, tört, túl nagy határidő, ismeretlen alkategória: 400, és a kérés többi mezője sem íródik', async () => {
    t = await createTestApp();
    await setupLeaves(t);
    await t.put('/api/settings', { opening_balance: '1000000', default_pay_days: '15' });
    for (const bad of [
      { opening_balance: 'egymillió' },
      { opening_balance: '1 000 000,50' },
      { profit_target: '12.5' },
      { default_pay_days: '999' },
      { default_oneoff_days_out: '-3' },
      { billingo_leaf_default: 'l_nincs' },
    ]) {
      const r = await t.put('/api/settings', { default_pay_days: '30', ...bad });
      expect([bad, r.status]).toEqual([bad, 400]);
      expect(r.data.error).toBeTruthy();
    }
    expect((await data()).settings).toMatchObject({ opening_balance: '1000000', default_pay_days: '15' });
  });
});

describe('riasztás „rendben” (POST /api/flags/ack)', () => {
  it('nyugtázás kétszer sem duplikál, a visszavonás csak a megadottat veszi ki; szerkesztő is nyugtázhat', async () => {
    t = await createTestApp();
    await asRole('member');
    const ack = async () => JSON.parse((await data()).settings.flags_ack || '[]');
    expect((await t.post('/api/flags/ack', { ids: ['unplanned:tx1', 'late:p2'] })).status).toBe(200);
    expect((await t.post('/api/flags/ack', { ids: ['unplanned:tx1'] })).status).toBe(200);
    expect(await ack()).toEqual(['unplanned:tx1', 'late:p2']);
    expect((await t.post('/api/flags/ack', { ids: ['unplanned:tx1'], undo: true })).status).toBe(200);
    expect(await ack()).toEqual(['late:p2']);
  });
});

describe('xls import (POST /api/import) – hibás kérés', () => {
  it('ismeretlen típus / nem tömb sorok: 400, semmi nem íródik', async () => {
    t = await createTestApp();
    const r = await t.post('/api/import', { kind: 'egyeb', rows: [] });
    expect(r.status).toBe(400);
    expect(r.data.error).toBe('Hibás import típus.');
    expect((await t.post('/api/import', { kind: 'actual', rows: 'Dátum;Összeg' })).status).toBe(400);
    expect(n('entries') + n('groups') + n('leaves')).toBe(0);
  });
});

describe('napló visszavonás (POST /api/changelog/:id/undo) – hibaágak', () => {
  it('nem létező bejegyzés 404; kétszeri visszavonás 400 és nem ír újra; a visszavonás-bejegyzés maga nem vonható vissza', async () => {
    t = await createTestApp();
    const L = await setupLeaves(t);
    await t.post('/api/entries/batch', { upsert: [plan('e1', L.minta)], expected: { e1: null } });
    const id = row("SELECT id FROM change_log WHERE action = 'entries'").id;
    expect((await t.post('/api/changelog/9999/undo')).status).toBe(404);
    expect((await t.post(`/api/changelog/${id}/undo`)).status).toBe(200);
    expect(n('entries')).toBe(0);
    const again = await t.post(`/api/changelog/${id}/undo`);
    expect(again.status).toBe(400);
    expect(again.data.error).toBe('Ezt már visszavonták.');
    const undoRow = row("SELECT id FROM change_log WHERE action = 'undo'").id;
    const meta = await t.post(`/api/changelog/${undoRow}/undo`);
    expect(meta.status).toBe(400);
    expect(meta.data.error).toBe('Ez a lépés nem vonható vissza.');
    expect(n('change_log')).toBe(2);
    expect(n('entries')).toBe(0);
  });
});

describe('kuka (POST /api/trash/restore) – idempotencia', () => {
  it('ugyanaz a visszaállítás kétszer: egy tétel, a második kérés nem duplikál és nem ír naplót', async () => {
    t = await createTestApp();
    const L = await setupLeaves(t);
    const tab = await openTab(t);
    await tab.commit(genSeries({ leaf: L.iroda, section: 'out', name: 'Rezsi', amount: 85_000, startYm: '2026-11', count: 1, rep: 'once', day: 12 }));
    await tab.reload();
    await tab.commit(deleteEntries(tab.data, [tab.data.entries[0].id]));
    const rid = row('SELECT rowid AS rid FROM deleted_entries').rid;
    expect((await t.post('/api/trash/restore', { rids: [rid] })).status).toBe(200);
    const logs = n('change_log');
    expect((await t.post('/api/trash/restore', { rids: [rid] })).status).toBe(200);
    expect(rows('SELECT amount FROM entries')).toEqual([{ amount: -85_000 }]);
    expect(n('deleted_entries')).toBe(0);
    expect(n('change_log')).toBe(logs);
  });
});

describe('xls import átnevezett kategóriákba', () => {
  it('átnevezett alkategória / mappa új nevére importált sor a meglévő sorba kerül (nem 500, nincs árva tétel)', async () => {
    t = await createTestApp();
    const L = await setupLeaves(t);
    expect((await t.patch(`/api/leaves/${L.minta}`, { label: 'Minta Hungary Kft.' })).status).toBe(200);
    expect((await t.patch(`/api/groups/${L.gout}`, { label: '3 Iroda és működés' })).status).toBe(200);
    const leavesBefore = n('leaves');
    const r = await t.post('/api/import', {
      kind: 'actual',
      rows: [
        { date: '2026-10-05', name: 'Havi díj', category: 'Projektek - Minta Hungary Kft.', amount: 250_000 },
        { date: '2026-10-12', name: 'Szerverbérlés', category: '3 Iroda és működés - Szoftver, beszerzés', amount: -49_000 },
      ],
    });
    expect(r.status).toBe(200);
    expect(rows('SELECT name, leaf_id FROM entries ORDER BY date')).toEqual([
      { name: 'Havi díj', leaf_id: L.minta },
      { name: 'Szerverbérlés', leaf_id: L.szoftver },
    ]);
    expect(n('leaves')).toBe(leavesBefore);
    expect(rows('SELECT count(*) AS n FROM entries e LEFT JOIN leaves l ON l.id = e.leaf_id WHERE l.id IS NULL')).toEqual([{ n: 0 }]);
  });
});
