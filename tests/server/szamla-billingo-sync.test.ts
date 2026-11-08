// Billingo kiállított számlák szinkronja a valódi backenden (memóriabeli SQLite), a közös Billingo-mockkal.
// Szándék (README, billingo.ts): a nyitott számla tervezett bevétel a fizetési határidőre; ha a tervben már szerepel
// ugyanaz a bevétel, a számla azt állítja „kiszámlázottra” (nincs dupla bevétel); a Billingo szerint fizetett számlából
// tény lesz, a terv lezárul és a tényhez kötődik (link_id). A terv összege a számla miatt nem változik (bill_amount).
import { afterEach, describe, expect, it, vi } from 'vitest';
import { reconcileInvoicePlans, syncBillingo } from '../../src/server/app/billingo';
import { computeFlags } from '../../src/shared/flags';
import { receivablesAging } from '../../src/shared/insights';
import { buildIndex } from '../../src/shared/model';
import { createTestApp, type TestApp } from '../helpers/app';
import { installMocks, mockBillingo, type BillingoMock } from '../helpers/mocks';

let t: TestApp | undefined;
let billingo: BillingoMock;
afterEach(() => {
  t?.close();
  t = undefined;
  vi.unstubAllGlobals();
});

const day = (n: number) => new Date(Date.now() + n * 86400_000).toISOString().slice(0, 10);

async function setup(opts: Parameters<typeof mockBillingo>[0] = {}) {
  billingo = mockBillingo(opts);
  const ext = installMocks(billingo);
  t = await createTestApp({ env: ext.env as any });
  t.sql.exec(`
    INSERT INTO groups (id, section, label) VALUES ('g_proj', 'in', 'Projektek'), ('g_ki', 'out', 'Működés');
    INSERT INTO leaves (id, group_id, label) VALUES
      ('l_minta', 'g_proj', 'Minta'), ('l_pelda', 'g_proj', 'Példa Bt'), ('l_domain', 'g_proj', 'Domain és tárhely'),
      ('l_irodaszer', 'g_ki', 'Irodaszer');
  `);
  return t;
}
const sync = () => syncBillingo(t!.env);

function plan(id: string, leaf: string, date: string, amount: number, name: string, extra: Record<string, unknown> = {}) {
  const row = { id, kind: 'plan', date, leaf_id: leaf, name, amount, done: 0, tentative: 0, source: 'manual', updated_at: 1, ...extra };
  const cols = Object.keys(row);
  t!.sql.prepare(`INSERT INTO entries (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`).run(...(Object.values(row) as any[]));
}
const entry = (id: string) => t!.sql.prepare('SELECT * FROM entries WHERE id = ?').get(id) as any;
const entries = (where = '1=1') => t!.sql.prepare(`SELECT * FROM entries WHERE ${where} ORDER BY id`).all() as any[];
const doc = (id: number) => t!.sql.prepare('SELECT * FROM billingo_docs WHERE id = ?').get(id) as any;

describe('Billingo szinkron – nyitott számlák a tervezett bevételbe', () => {
  it('terv nélküli nyitott számlából terv lesz a fizetési határidőre, a számla összegével', async () => {
    await setup();
    billingo.addDocument({ id: 9001, number: 'MNT-2026-000101', partner: 'Minta Kft.', gross: 254_000, dueDate: day(8), invoiceDate: day(-2) });
    expect(await sync()).toEqual({ docs: 1, plans: 1 });
    const p = entry('b9001');
    expect(p).toMatchObject({ kind: 'plan', date: day(8), leaf_id: 'l_minta', amount: 254_000, bill_amount: 254_000, done: 0, source: 'billingo', ext_ref: 'billingo:9001' });
    expect(p.name).toContain('MNT-2026-000101');
    expect(doc(9001)).toMatchObject({ plan_id: 'b9001', payment_status: 'outstanding', gross: 254_000 });
  });

  it('a meglévő tervet állítja „kiszámlázottra” – nincs dupla bevétel, a terv összege és neve marad', async () => {
    await setup();
    plan('p_havi', 'l_minta', day(10), 254_000, 'Havi díj – 2026. november');
    billingo.addDocument({ id: 9002, number: 'MNT-2026-000102', partner: 'Minta Kft.', gross: 254_000, dueDate: day(8) });
    await sync();
    expect(entry('b9002')).toBeUndefined();
    expect(entry('p_havi')).toMatchObject({ amount: 254_000, bill_amount: 254_000, ext_ref: 'billingo:9002', source: 'billingo', name: 'Havi díj – 2026. november', date: day(8) });
    expect(doc(9002).plan_id).toBe('p_havi');
    const open = entries("kind = 'plan' AND done = 0 AND leaf_id = 'l_minta'");
    expect(open.reduce((a, e) => a + e.amount, 0)).toBe(254_000);
  });

  it('eltérő összegű számla: a terv összege marad, a számla összege a bill_amount', async () => {
    await setup();
    plan('p_havi', 'l_minta', day(10), 300_000, 'Marketing tanácsadás');
    billingo.addDocument({ id: 9003, number: 'MNT-2026-000103', partner: 'Minta Kft.', gross: 281_940, dueDate: day(8) });
    await sync();
    expect(entry('p_havi')).toMatchObject({ amount: 300_000, plan_amount: 300_000, bill_amount: 281_940, ext_ref: 'billingo:9003' });
  });

  it('ismételt szinkron nem dupláz (idempotens), több oldalas listánál is', async () => {
    await setup({ perPage: 1 });
    plan('p_havi', 'l_minta', day(10), 254_000, 'Havi díj');
    billingo.addDocument({ id: 9004, number: 'MNT-2026-000104', partner: 'Minta Kft.', gross: 254_000, dueDate: day(8) });
    billingo.addDocument({ id: 9005, number: 'PLD-2026-000017', partner: 'Példa Bt.', gross: 63_500, dueDate: day(15) });
    await sync();
    const before = entries();
    await sync();
    await sync();
    expect(entries()).toEqual(before.map((e) => ({ ...e, updated_at: expect.any(Number) })));
    expect(entries("ext_ref LIKE 'billingo:%'").length).toBe(2);
    // az app 100-as lapmérettel kér
    expect(billingo.requests.filter((r) => r.path === '/documents').every((r) => r.query.per_page === '100')).toBe(true);
  });

  it('a Billingo szerint fizetett számla: tény a fizetés napjára, a terv lezárul és a tényhez kötődik', async () => {
    await setup();
    plan('p_havi', 'l_minta', day(-2), 254_000, 'Havi díj');
    billingo.addDocument({ id: 9006, number: 'MNT-2026-000106', partner: 'Minta Kft.', gross: 254_000, dueDate: day(-2), invoiceDate: day(-10) });
    await sync();
    billingo.pay(9006, { date: day(-1) });
    await sync();
    expect(entry('p_havi')).toMatchObject({ done: 1, link_id: 'bp9006' });
    expect(entry('bp9006')).toMatchObject({ kind: 'actual', date: day(-1), amount: 254_000, leaf_id: 'l_minta', source: 'billingo', ext_ref: 'bpaid:9006' });
    await sync();
    expect(entries("kind = 'actual'").length).toBe(1);
  });

  it('részben fizetett számla: a befolyt összeg részleges tény (a tervhez kötve), a terv a maradékkal nyitva marad', async () => {
    await setup();
    billingo.addDocument({ id: 9013, number: 'MNT-2026-000113', partner: 'Minta Kft.', gross: 500_000, dueDate: day(3) });
    await sync();
    billingo.pay(9013, { date: day(-1), amount: 200_000 });
    await sync();
    expect(doc(9013).payment_status).toBe('partially_paid');
    // a terv (és a számla összege) nem változik, nyitva marad
    expect(entry('b9013')).toMatchObject({ done: 0, amount: 500_000, bill_amount: 500_000, link_id: null });
    expect(entries("kind = 'actual'")).toEqual([
      expect.objectContaining({ id: 'bp9013_1', date: day(-1), amount: 200_000, leaf_id: 'l_minta', source: 'billingo', ext_ref: 'bpaid:9013_1', link_id: 'b9013' }),
    ]);
    // az előrejelzésben csak a még kintlévő 300 000 várható (a 200 000 már tény), a kintlévőségben is
    const data = (await t!.get('/api/data')).data;
    const ix = buildIndex(data);
    expect(ix.openPlan.get('l_minta')?.get(day(3).slice(0, 7))).toBe(300_000);
    expect(ix.actual.get('l_minta')?.get(day(-1).slice(0, 7))).toBe(200_000);
    expect(receivablesAging(data.entries, ix.sectionOf, data.today).buckets.reduce((s, b) => s + b.sum, 0)).toBe(300_000);
    // a részfizetés nem „eltérés” és nem „nem tervezett” tétel
    expect(computeFlags(data.entries, [], ix.sectionOf, data.today).filter((f) => f.entry_id === 'bp9013_1')).toEqual([]);

    // ismételt szinkron nem dupláz
    await sync();
    expect(entries("kind = 'actual'").length).toBe(1);

    // második részlet: újabb részleges tény, a maradék 200 000
    billingo.pay(9013, { date: day(0), amount: 100_000 });
    await sync();
    expect(entry('bp9013_2')).toMatchObject({ amount: 100_000, link_id: 'b9013' });
    expect(buildIndex((await t!.get('/api/data')).data).openPlan.get('l_minta')?.get(day(3).slice(0, 7))).toBe(200_000);

    // a maradék is befolyik: a fizetett számla ténye csak a maradék, a terv lezárul – összesen a számla összege
    billingo.pay(9013, { date: day(0), amount: 200_000 });
    await sync();
    expect(doc(9013).payment_status).toBe('paid');
    expect(entry('b9013')).toMatchObject({ done: 1, link_id: 'bp9013' });
    expect(entry('bp9013')).toMatchObject({ kind: 'actual', amount: 200_000, link_id: 'b9013', ext_ref: 'bpaid:9013' });
    expect(entries("kind = 'actual'").reduce((s, e) => s + e.amount, 0)).toBe(500_000);
    const end = (await t!.get('/api/data')).data;
    const ix2 = buildIndex(end);
    expect(ix2.openPlan.get('l_minta')?.get(day(3).slice(0, 7)) || 0).toBe(0);
    // a tervhez kötött tények együtt adják ki a számlát: nincs eltérés-riasztás
    expect(computeFlags(end.entries, [], ix2.sectionOf, end.today).filter((f) => f.entry_id.startsWith('bp9013'))).toEqual([]);
  });

  it('részfizetés a meglévő (saját) tervhez: a már rögzített azonos tény (pl. banki tétel) kötődik hozzá, nem lesz második', async () => {
    await setup();
    plan('p_havi', 'l_minta', day(5), 400_000, 'Fejlesztés – 2026. november');
    plan('a_bank', 'l_minta', day(-2), 150_000, 'Minta Kft.', { kind: 'actual', source: 'bank', ext_ref: 'bank:tx1' });
    billingo.addDocument({ id: 9014, number: 'MNT-2026-000114', partner: 'Minta Kft.', gross: 400_000, dueDate: day(5) });
    billingo.pay(9014, { date: day(-2), amount: 150_000 });
    await sync();
    expect(entry('p_havi')).toMatchObject({ done: 0, amount: 400_000, bill_amount: 400_000, ext_ref: 'billingo:9014' });
    expect(entry('a_bank')).toMatchObject({ link_id: 'p_havi', amount: 150_000 });
    expect(entries("kind = 'actual'").map((e) => e.id)).toEqual(['a_bank']);
    const ix = buildIndex((await t!.get('/api/data')).data);
    expect(ix.openPlan.get('l_minta')?.get(day(5).slice(0, 7))).toBe(250_000);
  });

  it('a fizetések lekérése hibára fut: a szinkron lefut, a terv a teljes összeggel nyitva marad, a következő kör pótolja', async () => {
    await setup();
    billingo.addDocument({ id: 9015, number: 'MNT-2026-000115', partner: 'Minta Kft.', gross: 300_000, dueDate: day(4) });
    billingo.pay(9015, { date: day(-1), amount: 100_000 });
    billingo.fail(500, { match: /\/payments$/ });
    await sync();
    expect(entry('b9015')).toMatchObject({ done: 0, amount: 300_000 });
    expect(entries("kind = 'actual'")).toEqual([]);
    await sync();
    expect(entry('bp9015_1')).toMatchObject({ amount: 100_000, link_id: 'b9015' });
  });

  it('fizetett számla, ha a tény már megvan (pl. xls import): ahhoz kötődik, nem lesz második tény', async () => {
    await setup();
    plan('p_havi', 'l_minta', day(-6), 254_000, 'Havi díj');
    plan('a_imp', 'l_minta', day(-3), 254_000, 'Minta', { kind: 'actual', source: 'import', ext_ref: 'imp:actual:x:1' });
    billingo.addDocument({ id: 9007, number: 'MNT-2026-000107', partner: 'Minta Kft.', gross: 254_000, dueDate: day(-6), status: 'paid', paidDate: day(-3) });
    await sync();
    expect(entry('p_havi')).toMatchObject({ done: 1, link_id: 'a_imp', ext_ref: 'billingo:9007' });
    expect(entries("kind = 'actual'").map((e) => e.id)).toEqual(['a_imp']);
  });

  it('devizás számla forintban (árfolyammal)', async () => {
    await setup();
    billingo.addDocument({ id: 9008, number: 'MNT-2026-000108', partner: 'Minta Kft.', gross: 1_000, currency: 'EUR', rate: 391.5, dueDate: day(12) });
    await sync();
    expect(entry('b9008')).toMatchObject({ amount: 391_500, bill_amount: 391_500 });
  });

  it('díjbekérő nem lesz bevétel', async () => {
    await setup();
    billingo.addDocument({ id: 9009, number: 'D-2026-1', partner: 'Minta Kft.', gross: 100_000, dueDate: day(5), type: 'proforma' });
    await sync();
    expect(entries()).toEqual([]);
  });

  it('sztornózott számla: a számlából lett terv törlődik, a sztornó bizonylat nem lesz bevétel', async () => {
    await setup();
    billingo.addDocument({ id: 9010, number: 'MNT-2026-000110', partner: 'Minta Kft.', gross: 120_000, dueDate: day(9) });
    await sync();
    expect(entry('b9010')).toBeDefined();
    billingo.cancel(9010);
    await sync();
    expect(entry('b9010')).toBeUndefined();
    expect(entries()).toEqual([]);
    expect(doc(9010)).toMatchObject({ cancelled: 1, plan_id: null });
  });

  it('sztornózott számla a saját (előre felvett) tervhez kötve: a terv NEM törlődik, a helyesbítő számla hozzá kötődik', async () => {
    await setup();
    plan('p_havi', 'l_minta', day(10), 254_000, 'Havi díj – 2026. november');
    billingo.addDocument({ id: 9011, number: 'MNT-2026-000111', partner: 'Minta Kft.', gross: 254_000, dueDate: day(8) });
    await sync();
    expect(entry('p_havi').ext_ref).toBe('billingo:9011');
    // a számlát sztornózzák, és helyette újat állítanak ki
    billingo.cancel(9011);
    billingo.addDocument({ id: 9012, number: 'MNT-2026-000112', partner: 'Minta Kft.', gross: 254_000, dueDate: day(8) });
    await sync();
    const p = entry('p_havi');
    expect(p).toMatchObject({ amount: 254_000, name: 'Havi díj – 2026. november', done: 0, ext_ref: 'billingo:9012' });
    expect(entry('b9012')).toBeUndefined();
    expect(doc(9011).plan_id).toBeNull();
    expect(doc(9012).plan_id).toBe('p_havi');
  });

  it.todo('helyesbítő (módosító) számla: az eredeti terv összege / bill_amount kövesse-e a különbözetet? (ma a „modification” típust figyelmen kívül hagyja)');
});

describe('Billingo szinkron – hibakezelés', () => {
  it.each([
    [429 as const, /túl sok kérés/],
    [500 as const, /HTTP 500/],
    [401 as const, /HTTP 401/],
    ['bad-json' as const, /JSON|Unexpected|token/i],
    ['timeout' as const, /timeout/i],
  ])('%s → érthető hiba, az adat érintetlen, a „legutóbbi szinkron” nem frissül', async (failure, msg) => {
    await setup();
    billingo.addDocument({ id: 9301, number: 'MNT-2026-000301', partner: 'Minta Kft.', gross: 254_000, dueDate: day(8) });
    billingo.fail(failure);
    await expect(sync()).rejects.toThrow(msg);
    expect(entries()).toEqual([]);
    expect(t!.sql.prepare("SELECT value FROM settings WHERE key = 'billingo_last_sync'").get()).toBeUndefined();
    // a következő szinkron rendben lefut
    await sync();
    expect(entry('b9301')).toBeDefined();
  });

  it('a teljes szinkronban (POST /api/sync) a Billingo-hiba nem állítja meg a többi lépést', async () => {
    await setup();
    billingo.fail(500);
    const r = await t!.post('/api/sync');
    expect(r.status).toBe(200);
    expect(r.data.billingoError).toMatch(/HTTP 500/);
  });

  it('ismeretlen végpont hívása hangos hibát ad (a mock nem válaszol némán)', async () => {
    await setup();
    await expect(fetch('https://billingo.mock/v3/partners', { headers: { 'X-API-KEY': 'teszt-billingo-kulcs' } })).rejects.toThrow(/nem támogatott/);
    await expect(fetch('https://ismeretlen.example/x')).rejects.toThrow(/nincs hozzá mock/);
  });
});

describe('Billingo szinkron – közös (több ügyfeles) kategória', () => {
  // valós minta: a „Domain és tárhely” sorban több ügyfél tárhelydíja van, a tervek nevében az ügyfél neve áll
  async function sharedLeaf() {
    await setup();
    t!.sql.exec(`
      INSERT INTO partner_rules (pattern, leaf_id, hits, updated_at) VALUES ('alfa tanacsado', 'l_domain', 1, 1), ('beta ingatlan', 'l_domain', 1, 1);
      INSERT INTO leaves (id, group_id, label) VALUES ('l_gamma', 'g_proj', 'GammaHomes');
    `);
  }

  it('más ügyfél nevére szóló tervet nem zár le (összegtől független „legközelebbi terv” sem)', async () => {
    await sharedLeaf();
    plan('p_gamma', 'l_domain', day(3), 48_387, 'GammaHomes – 2026. november');
    billingo.addDocument({ id: 9101, number: 'ALF-2026-000057', partner: 'Alfa Tanácsadó Kft.', gross: 102_235, dueDate: day(5) });
    await sync();
    expect(entry('p_gamma')).toMatchObject({ ext_ref: null, bill_amount: null, amount: 48_387, done: 0 });
    expect(entry('b9101')).toMatchObject({ leaf_id: 'l_domain', amount: 102_235 });
  });

  it('azonos összegnél sem viszi el a másik ügyfél tervét, a sajátját választja', async () => {
    await sharedLeaf();
    plan('p_beta', 'l_domain', day(2), 48_260, 'Beta – 2026. november');
    plan('p_alfa', 'l_domain', day(9), 48_260, 'Alfa – tárhely – 2026. november');
    billingo.addDocument({ id: 9102, number: 'ALF-2026-000058', partner: 'Alfa Tanácsadó Kft.', gross: 48_260, dueDate: day(3) });
    await sync();
    expect(entry('p_alfa').ext_ref).toBe('billingo:9102');
    expect(entry('p_beta').ext_ref).toBeNull();
  });

  it('a kategória nevére szóló (általános) tervhez köthető', async () => {
    await sharedLeaf();
    plan('p_dom', 'l_domain', day(4), 48_260, 'Domain és tárhely – 2026. november');
    billingo.addDocument({ id: 9103, number: 'BET-2026-000003', partner: 'Beta Ingatlan Kft.', gross: 48_260, dueDate: day(3) });
    await sync();
    expect(entry('p_dom').ext_ref).toBe('billingo:9103');
  });

  it('a saját partner-sorban az összegtől független terv-kötés megmarad (pl. „Marketing tanácsadás”)', async () => {
    await setup();
    plan('p_havi', 'l_minta', day(6), 1_497_000, 'Marketing tanácsadás – 2026. november');
    billingo.addDocument({ id: 9104, number: 'MNT-2026-000120', partner: 'Minta Kft.', gross: 1_005_408, dueDate: day(8) });
    await sync();
    expect(entry('p_havi')).toMatchObject({ ext_ref: 'billingo:9104', amount: 1_497_000, bill_amount: 1_005_408 });
  });
});

describe('Utólagos összevonás (reconcileInvoicePlans) – számla-sor + később felvett saját terv', () => {
  it('a később felvett saját tervhez kerül a számla-sor: egy sor marad, a terv összege és neve megmarad', async () => {
    await setup();
    billingo.addDocument({ id: 9201, number: 'MNT-2026-000130', partner: 'Minta Kft.', gross: 381_000, dueDate: day(7) });
    await sync();
    plan('p_seo', 'l_minta', day(9), 375_000, 'SEO – 2026. november');
    expect(await reconcileInvoicePlans(t!.env)).toBe(1);
    expect(entry('b9201')).toBeUndefined();
    expect(entry('p_seo')).toMatchObject({ ext_ref: 'billingo:9201', amount: 375_000, bill_amount: 381_000, name: 'SEO – 2026. november' });
    expect(doc(9201).plan_id).toBe('p_seo');
  });

  it('több ügyfeles sorban a másik ügyfél tervéhez nem vonja össze', async () => {
    await setup();
    t!.sql.exec(`INSERT INTO partner_rules (pattern, leaf_id, hits, updated_at) VALUES ('alfa tanacsado', 'l_domain', 1, 1);
      INSERT INTO leaves (id, group_id, label) VALUES ('l_gamma', 'g_proj', 'GammaHomes');`);
    billingo.addDocument({ id: 9202, number: 'ALF-2026-000060', partner: 'Alfa Tanácsadó Kft.', gross: 102_235, dueDate: day(5) });
    await sync();
    plan('p_gamma', 'l_domain', day(6), 48_387, 'GammaHomes – 2026. november');
    expect(await reconcileInvoicePlans(t!.env)).toBe(0);
    expect(entry('b9202')).toBeDefined();
    expect(entry('p_gamma').ext_ref).toBeNull();
  });
});
