// Író végpontok: banki tétel kihagyása / visszavétele, banki tétel és bankszámla módosítása, Enable Banking kapcsolat
// (connect + callback), Mac-ügynök kulcs / jelentés / szinkronkérés, Billingo kézi összevonás és „Projektbe”, NAV-számla
// besorolása a végponton át, kézi NAV-szinkron, diagnosztikai végpontok. Valódi backend, külső szolgáltatások mockolva.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createTestApp, type TestApp } from '../helpers/app';
import { installMocks, mockBillingo, mockNav, type BillingoMock, type NavMock } from '../helpers/mocks';
import { syncBillingo } from '../../src/server/app/billingo';

let t: TestApp | undefined;
afterEach(() => {
  t?.close();
  t = undefined;
  vi.unstubAllGlobals();
});

const day = (n: number) => new Date(Date.now() + n * 86400_000).toISOString().slice(0, 10);
const rows = (sql: string, ...args: any[]) => t!.sql.prepare(sql).all(...args) as any[];
const row = (sql: string, ...args: any[]) => t!.sql.prepare(sql).get(...args) as any;
const n = (table: string, where = '1=1', ...args: any[]) => row(`SELECT count(*) AS n FROM ${table} WHERE ${where}`, ...args).n as number;
const setting = (k: string) => row('SELECT value FROM settings WHERE key = ?', k)?.value ?? null;

function seed() {
  t!.sql.exec(`
    INSERT INTO groups (id, section, label) VALUES ('g_proj', 'in', 'Projektek'), ('g_aj', 'in', 'Ajánlatok'), ('g_ki', 'out', 'Működési költségek');
    INSERT INTO leaves (id, group_id, label) VALUES ('l_minta', 'g_proj', 'Minta'), ('l_tarhely', 'g_ki', 'Tárhely Szolgáltató'),
      ('l_konyv', 'g_ki', 'Könyvelés'), ('l_unf', 'g_ki', 'Előre nem látható költség'), ('l_ujugyfel', 'g_aj', 'Új Ügyfél Kft.');
    INSERT INTO bank_accounts (id, provider, bank_name, label) VALUES ('acc1', 'manual', 'Minta Bank', 'Folyószámla');
  `);
}
function tx(id: string, amount: number, status = 'new', extra: Record<string, unknown> = {}) {
  const r = { id, account_id: 'acc1', ext_id: id, date: day(-2), amount, partner: 'MINTA KFT', memo: '', status, created_at: 1, ...extra };
  const cols = Object.keys(r);
  t!.sql.prepare(`INSERT INTO bank_tx (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`).run(...(Object.values(r) as any[]));
}
function entry(r: Record<string, unknown>) {
  const e = { kind: 'plan', done: 0, tentative: 0, source: 'manual', updated_at: 1, name: '', ...r };
  const cols = Object.keys(e);
  t!.sql.prepare(`INSERT INTO entries (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`).run(...(Object.values(e) as any[]));
}
async function as(role: 'member' | 'viewer') {
  const email = `${role}@minta.hu`;
  await t!.addUser(email, role);
  await t!.loginAs(email);
}

describe('banki tétel kihagyása (POST /api/bank/ignore)', () => {
  it('kihagyás → archív, visszavétel → újra vár; kétszer küldve sem változik mást; jóváhagyott tételt nem érint', async () => {
    t = await createTestApp();
    seed();
    tx('t1', -4990);
    tx('t2', 150_000, 'approved', { actual_id: 'at2' });
    expect((await t.post('/api/bank/ignore', { ids: ['t1', 't2'] })).status).toBe(200);
    expect((await t.post('/api/bank/ignore', { ids: ['t1', 't2'] })).status).toBe(200);
    expect(rows('SELECT id, status FROM bank_tx ORDER BY id')).toEqual([
      { id: 't1', status: 'ignored' },
      { id: 't2', status: 'approved' },
    ]);
    expect((await t.get('/api/data')).data.bankTx.find((x: any) => x.id === 't1').status).toBe('ignored');
    expect((await t.post('/api/bank/ignore', { ids: ['t1', 't2'], undo: true })).status).toBe(200);
    expect(rows('SELECT id, status FROM bank_tx ORDER BY id')).toEqual([
      { id: 't1', status: 'new' },
      { id: 't2', status: 'approved' },
    ]);
  });

  it('olvasó 403; nem tömb azonosító-lista 400 (nem 500)', async () => {
    t = await createTestApp();
    seed();
    tx('t1', -4990);
    const bad = await t.post('/api/bank/ignore', { ids: 't1' });
    expect(bad.status).toBe(400);
    expect((await t.post('/api/bank/unapprove', { ids: 't1' })).status).toBe(400);
    expect((await t.post('/api/bank/approve', { items: { id: 't1' } })).status).toBe(400);
    await as('viewer');
    for (const [p, b] of [
      ['/api/bank/ignore', { ids: ['t1'] }],
      ['/api/bank/approve', { ids: ['t1'] }],
      ['/api/bank/unapprove', { ids: ['t1'] }],
      ['/api/bank/import', { bank_name: 'Minta Bank', rows: [] }],
    ] as const)
      expect([p, (await t.post(p, b)).status]).toEqual([p, 403]);
    expect(row("SELECT status FROM bank_tx WHERE id = 't1'").status).toBe('new');
    expect(n('entries')).toBe(0);
  });
});

describe('banki tétel módosítása (PATCH /api/bank/tx/:id)', () => {
  it('várakozó tétel kategóriája / terve; ismeretlen tétel 404, kategória / terv 400; jóváhagyott tétel 409 – változás nélkül', async () => {
    t = await createTestApp();
    seed();
    tx('t1', -4990);
    tx('t2', -36_830, 'approved', { leaf_id: 'l_konyv', actual_id: 'at2' });
    entry({ id: 'p_tarhely', date: day(3), leaf_id: 'l_tarhely', amount: -4990, name: 'Tárhely' });
    expect((await t.patch('/api/bank/tx/t1', { leaf_id: 'l_tarhely', plan_id: 'p_tarhely' })).status).toBe(200);
    expect(row("SELECT leaf_id, plan_id FROM bank_tx WHERE id = 't1'")).toEqual({ leaf_id: 'l_tarhely', plan_id: 'p_tarhely' });

    expect((await t.patch('/api/bank/tx/nincs', { leaf_id: 'l_unf' })).status).toBe(404);
    expect((await t.patch('/api/bank/tx/t1', { leaf_id: 'l_nincs' })).status).toBe(400);
    expect((await t.patch('/api/bank/tx/t1', { leaf_id: 'l_unf', plan_id: 'p_nincs' })).status).toBe(400);
    const approved = await t.patch('/api/bank/tx/t2', { leaf_id: 'l_unf' });
    expect(approved.status).toBe(409);
    expect(approved.data.error).toMatch(/vond vissza/);
    expect(rows('SELECT id, leaf_id, plan_id FROM bank_tx ORDER BY id')).toEqual([
      { id: 't1', leaf_id: 'l_tarhely', plan_id: 'p_tarhely' },
      { id: 't2', leaf_id: 'l_konyv', plan_id: null },
    ]);
    // a javaslat törölhető
    expect((await t.patch('/api/bank/tx/t1', { plan_id: null })).status).toBe(200);
    expect(row("SELECT plan_id FROM bank_tx WHERE id = 't1'").plan_id).toBeNull();
  });
});

describe('bankszámla (PATCH /api/bank/accounts/:id, csak admin)', () => {
  it('név, ki-/bekapcsolás, kézi egyenleg; hibás egyenleg / bankkapcsolatos számla egyenlege 400; ismeretlen számla 404', async () => {
    t = await createTestApp();
    seed();
    t.sql.exec("INSERT INTO bank_accounts (id, provider, bank_name, label, balance) VALUES ('acc_eb', 'enablebanking', 'Másik Bank', 'Üzleti', 2345678)");
    expect((await t.patch('/api/bank/accounts/acc1', { label: 'Fő számla', balance: '1 250 000 Ft' })).status).toBe(200);
    expect((await t.get('/api/data')).data.accounts.find((a: any) => a.id === 'acc1')).toMatchObject({ label: 'Fő számla', balance: 1_250_000, active: 1 });
    expect((await t.patch('/api/bank/accounts/acc1', { active: false })).status).toBe(200);
    expect(row("SELECT active FROM bank_accounts WHERE id = 'acc1'").active).toBe(0);

    const garbage = await t.patch('/api/bank/accounts/acc1', { balance: 'sok', label: 'Átnevezve' });
    expect(garbage.status).toBe(400);
    expect(garbage.data.error).toMatch(/Hibás egyenleg/);
    const eb = await t.patch('/api/bank/accounts/acc_eb', { balance: '0' });
    expect(eb.status).toBe(400);
    expect((await t.patch('/api/bank/accounts/acc1', { label: ' ' })).status).toBe(400);
    expect((await t.patch('/api/bank/accounts/nincs', { active: true })).status).toBe(404);
    expect(rows('SELECT id, label, balance FROM bank_accounts ORDER BY id')).toEqual([
      { id: 'acc1', label: 'Fő számla', balance: 1_250_000 },
      { id: 'acc_eb', label: 'Üzleti', balance: 2_345_678 },
    ]);
    // üres egyenleg: nincs megadva (a számított egyenleg számít)
    expect((await t.patch('/api/bank/accounts/acc1', { balance: null })).status).toBe(200);
    expect(row("SELECT balance FROM bank_accounts WHERE id = 'acc1'").balance).toBeNull();

    await as('member');
    expect((await t.patch('/api/bank/accounts/acc1', { active: true })).status).toBe(403);
    expect(row("SELECT active FROM bank_accounts WHERE id = 'acc1'").active).toBe(0);
  });
});

describe('Enable Banking kapcsolat (POST /api/bank/connect, GET /api/bank/callback)', () => {
  async function ebApp() {
    const kp = (await crypto.subtle.generateKey(
      { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
      true,
      ['sign', 'verify'],
    )) as CryptoKeyPair;
    const pem = `-----BEGIN PRIVATE KEY-----\n${Buffer.from(await crypto.subtle.exportKey('pkcs8', kp.privateKey)).toString('base64')}\n-----END PRIVATE KEY-----`;
    const calls: { method: string; path: string; body: any }[] = [];
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const req = new Request(input, init);
      const u = new URL(req.url);
      if (u.host !== 'api.enablebanking.com') throw new Error('váratlan külső hívás: ' + req.url);
      const body = req.method === 'POST' ? await req.json() : null;
      calls.push({ method: req.method, path: u.pathname, body });
      const j = (o: unknown) => new Response(JSON.stringify(o), { headers: { 'Content-Type': 'application/json' } });
      if (u.pathname === '/auth') return j({ url: 'https://bank.example/login?x=1', authorization_id: 'auth-1' });
      if (u.pathname === '/sessions')
        return j({
          session_id: 'sess-1',
          aspsp: { name: 'Minta Bank' },
          access: { valid_until: '2027-05-01T00:00:00Z' },
          accounts: [{ uid: 'uid-1', account_id: { iban: 'HU42117730161111101800000000' }, name: 'Üzleti számla', currency: 'HUF' }],
        });
      if (u.pathname.endsWith('/balances')) return j({ balances: [{ balance_type: 'CLAV', balance_amount: { amount: '1000000.00', currency: 'HUF' } }] });
      if (u.pathname.endsWith('/transactions')) return j({ transactions: [] });
      return new Response('nincs', { status: 404 });
    });
    t = await createTestApp({ env: { EB_APP_ID: 'teszt-app', EB_PRIVATE_KEY: pem } as any });
    seed();
    return calls;
  }

  it('kapcsolódás: állapot-kulcs, callback után új számla, a kézi számla kikapcsol; a callback nem ismételhető', async () => {
    const calls = await ebApp();
    const c = await t!.post('/api/bank/connect', { bank_name: 'Minta Bank', days: 90 });
    expect(c.status).toBe(200);
    expect(c.data.url).toBe('https://bank.example/login?x=1');
    const state = calls[0].body.state;
    expect(row('SELECT bank_name, user_id FROM oauth_states WHERE state = ?', state)).toEqual({ bank_name: 'Minta Bank', user_id: t!.userId });

    const cb = await t!.get(`/api/bank/callback?state=${state}&code=kod-123`);
    expect(cb.status).toBe(302);
    expect(cb.headers.get('Location')).toBe('https://cashflow.test/?bank=ok');
    expect(calls.find((x) => x.path === '/sessions')?.body).toEqual({ code: 'kod-123' });
    expect(rows("SELECT provider, bank_name, label, iban, eb_account_uid, eb_session_id, valid_until, active, balance FROM bank_accounts WHERE provider = 'enablebanking'")).toEqual([
      {
        provider: 'enablebanking',
        bank_name: 'Minta Bank',
        label: 'Üzleti számla',
        iban: 'HU42117730161111101800000000',
        eb_account_uid: 'uid-1',
        eb_session_id: 'sess-1',
        valid_until: '2027-05-01T00:00:00Z',
        active: 1,
        balance: 1_000_000,
      },
    ]);
    expect(row("SELECT active FROM bank_accounts WHERE id = 'acc1'").active).toBe(0);
    expect(n('oauth_states')).toBe(0);

    // ugyanaz a visszahívás még egyszer (frissítés, visszalépés): hiba, nem jön létre második számla
    const again = await t!.get(`/api/bank/callback?state=${state}&code=kod-123`);
    expect(again.headers.get('Location')).toMatch(/bank=error/);
    expect(n('bank_accounts', "provider = 'enablebanking'")).toBe(1);
  });

  it('idegen / lejárt állapot-kulcs, másik felhasználó: hiba-átirányítás, nincs új számla; kapcsolódni csak admin tud', async () => {
    await ebApp();
    const c = await t!.post('/api/bank/connect', { bank_name: 'Minta Bank' });
    const state = row('SELECT state FROM oauth_states').state;
    expect(c.status).toBe(200);
    expect((await t!.get('/api/bank/callback?state=hamis&code=x')).headers.get('Location')).toMatch(/bank=error/);
    expect((await t!.post('/api/bank/connect', { bank_name: '' })).status).toBe(400);
    await as('member');
    expect((await t!.get(`/api/bank/callback?state=${state}&code=x`)).headers.get('Location')).toMatch(/bank=error/);
    expect((await t!.post('/api/bank/connect', { bank_name: 'Minta Bank' })).status).toBe(403);
    expect(n('bank_accounts', "provider = 'enablebanking'")).toBe(0);
    expect(row("SELECT active FROM bank_accounts WHERE id = 'acc1'").active).toBe(1);
    expect(n('oauth_states')).toBe(1);
  });
});

describe('Mac-ügynök: feltöltési kulcs, jelentés, szinkronkérés', () => {
  it('kulcs létrehozása (csak admin) → jelentés és kérés a kulccsal; visszavonás után a kulcs érvénytelen', async () => {
    t = await createTestApp();
    const tok = (await t.post('/api/ingest/token')).data.token as string;
    expect(JSON.parse(setting('import_token'))).toMatchObject({ user_id: t.userId });
    expect(setting('import_token')).not.toContain(tok); // csak a hash-e tárolódik
    const bearer = { Authorization: 'Bearer ' + tok };

    const rep = await t.call('POST', '/api/ingest/report?ok=1', 'BiNX: 3 tétel, MagNet: 0 tétel', bearer);
    expect(rep.status).toBe(200);
    expect(JSON.parse(setting('ingest_report'))).toMatchObject({ ok: true, msg: 'BiNX: 3 tétel, MagNet: 0 tétel' });
    expect((await t.call('POST', '/api/ingest/request', {}, bearer)).status).toBe(200);
    expect(JSON.parse(setting('ingest_request'))).toMatchObject({ by: 'robot' });
    const st = (await t.get('/api/ingest/token')).data;
    expect(st).toMatchObject({ active: true, report: { ok: true }, request: { by: 'robot' } });

    expect((await t.del('/api/ingest/token')).status).toBe(200);
    expect(setting('import_token')).toBeNull();
    const after = await t.call('POST', '/api/ingest/report?ok=0', 'hiba', bearer);
    expect(after.status).toBe(401);
    expect(JSON.parse(setting('ingest_report')).ok).toBe(true);
  });

  it('kulcs nélkül a jelentés 401; szinkronkérés munkamenettel: szerkesztő igen (a nevével), olvasó nem; kulcsot csak admin kezel', async () => {
    t = await createTestApp();
    expect((await t.call('POST', '/api/ingest/report?ok=1', 'x', { Authorization: 'Bearer rossz' })).status).toBe(401);
    expect(setting('ingest_report')).toBeNull();
    await as('member');
    expect((await t.post('/api/ingest/request')).status).toBe(200);
    expect(JSON.parse(setting('ingest_request'))).toMatchObject({ by: 'member@minta.hu' });
    expect((await t.post('/api/ingest/token')).status).toBe(403);
    expect((await t.del('/api/ingest/token')).status).toBe(403);
    t.sql.prepare("DELETE FROM settings WHERE key = 'ingest_request'").run();
    await as('viewer');
    expect((await t.post('/api/ingest/request')).status).toBe(403);
    expect(setting('ingest_request')).toBeNull();
    expect(setting('import_token')).toBeNull();
  });
});

describe('Billingo kézi összevonás (POST /api/billingo/attach) és „Projektbe” (POST /api/billingo/promote)', () => {
  let billingo: BillingoMock;
  async function setup() {
    billingo = mockBillingo();
    const ext = installMocks(billingo);
    t = await createTestApp({ env: ext.env as any });
    seed();
  }

  it('a terv nélkül jött számla-sor a partner saját tervéhez kerül: a terv összege marad, a számla összege bill_amount; ismétlés nem duplikál', async () => {
    await setup();
    billingo.addDocument({ id: 9401, number: 'MNT-2026-000301', partner: 'Minta Kft.', gross: 190_500, dueDate: day(8), invoiceDate: day(-2) });
    await syncBillingo(t!.env);
    expect(row("SELECT id, leaf_id, amount, ext_ref FROM entries WHERE id = 'b9401'")).toEqual({ id: 'b9401', leaf_id: 'l_minta', amount: 190_500, ext_ref: 'billingo:9401' });
    entry({ id: 'p_sajat', date: day(20), leaf_id: 'l_minta', amount: 254_000, name: 'Havi díj', period: day(20).slice(0, 7) });

    const r = await t!.post('/api/billingo/attach', { id: 'b9401', plan_id: 'p_sajat' });
    expect(r.status).toBe(200);
    expect(row("SELECT id, amount, plan_amount, bill_amount, ext_ref, source, date FROM entries WHERE id = 'p_sajat'")).toEqual({
      id: 'p_sajat',
      amount: 254_000,
      plan_amount: 254_000,
      bill_amount: 190_500,
      ext_ref: 'billingo:9401',
      source: 'billingo',
      date: day(8),
    });
    expect(n('entries', "id = 'b9401'")).toBe(0);
    expect(row('SELECT plan_id FROM billingo_docs WHERE id = 9401').plan_id).toBe('p_sajat');
    const d = (await t!.get('/api/data')).data;
    expect(d.entries.filter((e: any) => e.kind === 'plan').map((e: any) => e.id)).toEqual(['p_sajat']);

    const again = await t!.post('/api/billingo/attach', { id: 'b9401', plan_id: 'p_sajat' });
    expect(again.status).toBe(404);
    // a következő szinkron sem hozza vissza külön sorként
    await syncBillingo(t!.env);
    expect(rows("SELECT id FROM entries WHERE kind = 'plan'")).toEqual([{ id: 'p_sajat' }]);
  });

  it('lezárt / más számlás terv 400, ismeretlen számla-sor 404, olvasó 403 – változás nélkül', async () => {
    await setup();
    billingo.addDocument({ id: 9402, number: 'MNT-2026-000302', partner: 'Minta Kft.', gross: 63_500, dueDate: day(8), invoiceDate: day(-2) });
    await syncBillingo(t!.env);
    entry({ id: 'p_kesz', date: day(-20), leaf_id: 'l_minta', amount: 254_000, done: 1 });
    entry({ id: 'p_masik', date: day(10), leaf_id: 'l_minta', amount: 254_000, ext_ref: 'billingo:9999' });
    const before = rows('SELECT * FROM entries ORDER BY id');
    expect((await t!.post('/api/billingo/attach', { id: 'b9402', plan_id: 'p_kesz' })).status).toBe(400);
    expect((await t!.post('/api/billingo/attach', { id: 'b9402', plan_id: 'p_masik' })).status).toBe(400);
    expect((await t!.post('/api/billingo/attach', { id: 'p_kesz', plan_id: 'p_masik' })).status).toBe(404);
    await as('viewer');
    expect((await t!.post('/api/billingo/attach', { id: 'b9402', plan_id: 'p_masik' })).status).toBe(403);
    expect((await t!.post('/api/billingo/promote')).status).toBe(403);
    expect(rows('SELECT * FROM entries ORDER BY id')).toEqual(before);
  });

  it('„Projektbe”: az Ajánlatok mappa kifizetett tétele a partner projekt-sorába kerül, a nyitott ajánlat marad; ismételve nem mozgat', async () => {
    await setup();
    entry({ id: 'a_elso', kind: 'actual', date: day(-5), leaf_id: 'l_ujugyfel', amount: 480_000, name: 'Arculat 1. részlet' });
    entry({ id: 'p_ajanlat', date: day(30), leaf_id: 'l_ujugyfel', amount: 480_000, tentative: 1, name: 'Arculat 2. részlet' });
    tx('t_elso', 480_000, 'approved', { leaf_id: 'l_ujugyfel', actual_id: 'a_elso' });
    const r = await t!.post('/api/billingo/promote');
    expect(r.status).toBe(200);
    expect(r.data.moved).toBe(1);
    const proj = row("SELECT l.id, g.label AS g FROM leaves l JOIN groups g ON g.id = l.group_id WHERE l.label = 'Új Ügyfél Kft.' AND g.id <> 'g_aj'");
    expect(proj.g).toBe('Projektek');
    expect(row("SELECT leaf_id FROM entries WHERE id = 'a_elso'").leaf_id).toBe(proj.id);
    expect(row("SELECT leaf_id FROM bank_tx WHERE id = 't_elso'").leaf_id).toBe(proj.id);
    expect(row("SELECT leaf_id FROM entries WHERE id = 'p_ajanlat'").leaf_id).toBe('l_ujugyfel');
    expect((await t!.post('/api/billingo/promote')).data.moved).toBe(0);
  });
});

describe('NAV-számla besorolása a végponton át (POST /api/nav/resolve)', () => {
  function navInvoice(id = 'nav:12345678:TSZ-2026/0815', extra: Record<string, unknown> = {}) {
    const r = {
      id,
      direction: 'INBOUND',
      invoice_number: id.split(':')[2],
      partner_tax: '12345678-2-41',
      partner_name: 'Tárhely Szolgáltató Kft.',
      issue_date: day(-6),
      payment_date: day(4),
      gross: -12_700,
      status: 'new',
      created_at: 1,
      updated_at: 1,
      ...extra,
    };
    const cols = Object.keys(r);
    t!.sql.prepare(`INSERT INTO nav_invoices (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`).run(...(Object.values(r) as any[]));
    return id;
  }
  const nav = (id: string) => row('SELECT status, plan_id, leaf_id FROM nav_invoices WHERE id = ?', id);

  it('„előre nem látható” → terv; visszavonás („reopen”) → a terv a kukába, a számla újra riaszt', async () => {
    t = await createTestApp();
    seed();
    const id = navInvoice();
    const r = await t.post('/api/nav/resolve', { id, action: 'unforeseen' });
    expect(r.status).toBe(200);
    const nv = nav(id);
    expect(nv).toMatchObject({ status: 'planned', leaf_id: 'l_unf' });
    expect(row('SELECT kind, leaf_id, amount, date, source, ext_ref, done FROM entries WHERE id = ?', nv.plan_id)).toEqual({
      kind: 'plan',
      leaf_id: 'l_unf',
      amount: -12_700,
      date: day(4),
      source: 'nav',
      ext_ref: id,
      done: 0,
    });
    expect((await t.get('/api/data')).data.navInvoices.find((x: any) => x.id === id).status).toBe('planned');

    expect((await t.post('/api/nav/resolve', { id, action: 'reopen' })).status).toBe(200);
    expect(nav(id)).toMatchObject({ status: 'new', plan_id: null });
    expect(n('entries')).toBe(0);
    expect(rows('SELECT id, amount FROM deleted_entries')).toEqual([{ id: nv.plan_id, amount: -12_700 }]);
  });

  it('„havonta tervbe”: N havi terv egy sorozatban + tanult partner-szabály; visszavonáskor minden nyitott hónap a kukába', async () => {
    t = await createTestApp();
    seed();
    const id = navInvoice();
    expect((await t.post('/api/nav/resolve', { id, action: 'recurring', leaf_id: 'l_tarhely', months: 3 })).status).toBe(200);
    const plans = rows("SELECT id, date, amount, series_id FROM entries WHERE kind = 'plan' ORDER BY date");
    expect(plans).toHaveLength(3);
    expect(new Set(plans.map((p) => p.series_id)).size).toBe(1);
    expect(plans.every((p) => p.amount === -12_700)).toBe(true);
    expect(row('SELECT leaf_id FROM partner_rules').leaf_id).toBe('l_tarhely');
    expect((await t.post('/api/nav/resolve', { id, action: 'reopen' })).status).toBe(200);
    expect(n('entries')).toBe(0);
    expect(n('deleted_entries')).toBe(3);
  });

  it.todo(
    'KÉRDÉS: a besorolás visszavonása („reopen”, a toast „Visszavon” gombja) a tanult partner-szabályt (és a sorozat sort) meghagyja – a következő számla így is ebbe a kategóriába kerül. Vissza kellene vonni a tanulást is?',
  );

  it('már besorolt számla újabb besorolása 409 (a terv és a számla kategóriája nem válik el); áthelyezés („move”) mindkettőt viszi', async () => {
    t = await createTestApp();
    seed();
    const id = navInvoice();
    await t.post('/api/nav/resolve', { id, action: 'assign', leaf_id: 'l_tarhely' });
    const planId = nav(id).plan_id;
    const dup = await t.post('/api/nav/resolve', { id, action: 'assign', leaf_id: 'l_konyv' });
    expect(dup.status).toBe(409);
    expect(dup.data.error).toMatch(/már be van sorolva/);
    expect(nav(id)).toMatchObject({ status: 'planned', leaf_id: 'l_tarhely', plan_id: planId });
    expect(rows('SELECT id, leaf_id FROM entries')).toEqual([{ id: planId, leaf_id: 'l_tarhely' }]);

    expect((await t.post('/api/nav/resolve', { id, action: 'move', leaf_id: 'l_konyv' })).status).toBe(200);
    expect(nav(id).leaf_id).toBe('l_konyv');
    expect(row('SELECT leaf_id FROM entries WHERE id = ?', planId).leaf_id).toBe('l_konyv');
  });

  it('kihagyás és visszanyitás; hibás művelet / ismeretlen számla / kategória nélkül: 4xx; olvasó 403', async () => {
    t = await createTestApp();
    seed();
    const id = navInvoice();
    expect((await t.post('/api/nav/resolve', { id, action: 'ignore' })).status).toBe(200);
    expect(nav(id).status).toBe('ignored');
    expect((await t.post('/api/nav/resolve', { id, action: 'reopen' })).status).toBe(200);
    expect(nav(id).status).toBe('new');

    const bad = await t.post('/api/nav/resolve', { id, action: 'torles' });
    expect(bad.status).toBe(400);
    expect(bad.data.error).toBe('Hibás művelet.');
    expect((await t.post('/api/nav/resolve', { id: 'nav:nincs', action: 'unforeseen' })).status).toBe(404);
    expect((await t.post('/api/nav/resolve', { id, action: 'assign' })).status).toBe(400);
    expect((await t.post('/api/nav/resolve', { id, action: 'assign', leaf_id: 'l_nincs' })).status).toBe(400);
    expect((await t.post('/api/nav/resolve', { id, action: 'move', leaf_id: 'l_konyv' })).status).toBe(400); // még nincs besorolva
    await as('viewer');
    expect((await t.post('/api/nav/resolve', { id, action: 'unforeseen' })).status).toBe(403);
    expect(nav(id)).toMatchObject({ status: 'new', plan_id: null });
    expect(n('entries') + n('partner_rules')).toBe(0);
  });
});

describe('kézi NAV-szinkron (POST /api/nav/sync, csak admin)', () => {
  let navMock: NavMock;
  it('beállítás nélkül 400; mockkal a számlák beérkeznek; tartós NAV-hiba 502; szerkesztő 403', async () => {
    t = await createTestApp();
    const off = await t.post('/api/nav/sync');
    expect(off.status).toBe(400);
    expect(off.data.error).toMatch(/NAV kapcsolat/);
    t.close();

    navMock = mockNav();
    const ext = installMocks(navMock);
    t = await createTestApp({ env: ext.env as any });
    seed();
    navMock.addInvoice({ number: 'TSZ-2026/0815', supplierName: 'Tárhely Szolgáltató Kft.', supplierTax: '12345678-2-41', issueDate: day(-6), paymentDate: day(2), gross: 12_700 });
    const r = await t.post('/api/nav/sync', { from: day(-30) });
    expect(r.status).toBe(200);
    expect(r.data).toMatchObject({ invoices: 1, unplanned: 1 });
    expect(rows('SELECT invoice_number, gross, status FROM nav_invoices')).toEqual([{ invoice_number: 'TSZ-2026/0815', gross: -12_700, status: 'new' }]);
    // ismételt szinkron nem duplikál
    await t.post('/api/nav/sync', { from: day(-30) });
    expect(n('nav_invoices')).toBe(1);

    navMock.failNav('INVALID_SECURITY_USER', 'Hibás technikai felhasználó', { times: 10 });
    const fail = await t.post('/api/nav/sync');
    expect(fail.status).toBe(502);
    expect(n('nav_invoices')).toBe(1);
    await as('member');
    expect((await t.post('/api/nav/sync')).status).toBe(403);
  });
});

describe('diagnosztikai végpontok (/api/diag/*)', () => {
  const TOKEN = 'diag-teszt-kulcs-0123456789abcdef-XYZ';
  it('kulcs nélkül / rossz kulccsal / túl rövid beállított kulccsal 404 és nem fut szinkron; jó kulccsal lefut', async () => {
    const navMock = mockNav();
    const ext = installMocks(navMock);
    t = await createTestApp({ env: { ...ext.env, DIAG_TOKEN: TOKEN } as any, login: false });
    seed();
    navMock.addInvoice({ number: 'KI-2026-515', supplierName: 'Könyvelő Iroda Kft.', supplierTax: '87654321-2-13', issueDate: day(-8), paymentDate: day(5), gross: 36_830 });
    for (const p of ['/api/diag/sync', '/api/diag/nav', '/api/diag/autopay']) {
      expect([p, (await t.call('POST', p, {})).status]).toEqual([p, 404]);
      expect([p, (await t.call('POST', p, {}, { 'X-Diag-Token': TOKEN.slice(0, -1) + 'Q' })).status]).toEqual([p, 404]);
    }
    expect(n('nav_invoices')).toBe(0);
    expect(setting('nav_last_sync')).toBeNull();

    const ok = await t.call('POST', '/api/diag/nav', {}, { 'X-Diag-Token': TOKEN });
    expect(ok.status).toBe(200);
    expect(ok.data).toMatchObject({ ok: true, invoices: 1 });
    expect(n('nav_invoices')).toBe(1);
    t.close();

    t = await createTestApp({ env: { DIAG_TOKEN: 'rovid-kulcs' } as any, login: false });
    expect((await t.call('POST', '/api/diag/sync', {}, { 'X-Diag-Token': 'rovid-kulcs' })).status).toBe(404);
  });

  it('autopay: próbafutás (alapértelmezés) nem ír a Billingóba és az adatbázisba; ?run=1 élesben rögzíti a fizetést', async () => {
    const billingo = mockBillingo();
    const ext = installMocks(billingo);
    t = await createTestApp({ env: { ...ext.env, DIAG_TOKEN: TOKEN } as any });
    seed();
    billingo.addDocument({ id: 9303, number: 'MNT-2026-000203', partner: 'Minta Kft.', gross: 63_500, dueDate: day(2), invoiceDate: day(-6) });
    await syncBillingo(t.env);
    tx('tx4', 63_500, 'new', { date: day(-1), memo: 'MNT-2026-000203' });
    const snap = () => ({ e: rows('SELECT * FROM entries ORDER BY id'), b: rows('SELECT * FROM bank_tx'), d: rows('SELECT * FROM billingo_docs') });
    const before = snap();
    const dry = await t.call('POST', '/api/diag/autopay', {}, { 'X-Diag-Token': TOKEN });
    expect(dry.status).toBe(200);
    expect(dry.data).toMatchObject({ dry: true, paid: 0 });
    expect(billingo.payments).toEqual([]);
    expect(snap()).toEqual(before);

    const run = await t.call('POST', '/api/diag/autopay?run=1', {}, { 'X-Diag-Token': TOKEN });
    expect(run.status).toBe(200);
    expect(billingo.payments).toHaveLength(1);
    expect(row("SELECT status FROM bank_tx WHERE id = 'tx4'").status).toBe('approved');
  });
});
