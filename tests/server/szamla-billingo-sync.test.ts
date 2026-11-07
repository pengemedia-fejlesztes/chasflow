// Billingo kiállított számlák szinkronja a valódi backenden (memóriabeli SQLite), kiváltott Billingo API-val.
// Szándék (README, billingo.ts): a nyitott számla tervezett bevétel a fizetési határidőre; ha a tervben már szerepel
// ugyanaz a bevétel, a számla azt állítja „kiszámlázottra” (nincs dupla bevétel); a Billingo szerint fizetett számlából
// tény lesz, a terv lezárul és a tényhez kötődik (link_id). A terv összege a számla miatt nem változik (bill_amount).
import { afterEach, describe, expect, it, vi } from 'vitest';
import { syncBillingo } from '../../src/server/app/billingo';
import { createTestApp, type TestApp } from '../helpers/app';

let t: TestApp | undefined;
afterEach(() => {
  t?.close();
  t = undefined;
  vi.unstubAllGlobals();
});

const day = (n: number) => new Date(Date.now() + n * 86400_000).toISOString().slice(0, 10);

interface Doc {
  id: number;
  invoice_number: string;
  partner: string;
  taxcode?: string;
  gross: number;
  due: string;
  status?: string;
  paid_date?: string;
  cancelled?: boolean;
  currency?: string;
  rate?: number;
  type?: string;
}
const toApi = (d: Doc) => ({
  id: d.id,
  invoice_number: d.invoice_number,
  type: d.type || 'invoice',
  cancelled: !!d.cancelled,
  payment_status: d.status || 'outstanding',
  gross_total: d.gross,
  currency: d.currency || 'HUF',
  conversion_rate: d.rate || 1,
  invoice_date: day(-5),
  due_date: d.due,
  paid_date: d.paid_date,
  partner: { name: d.partner, taxcode: d.taxcode },
});

function stubBillingo(docs: Doc[]) {
  const fetch = vi.fn(async (url: string | URL | Request) => {
    const u = String(url);
    if (u.startsWith('https://billingo.mock/documents?')) return Response.json({ data: docs.map(toApi), current_page: 1, last_page: 1 });
    throw new Error('váratlan hívás: ' + u);
  });
  vi.stubGlobal('fetch', fetch);
  return fetch;
}

async function setup() {
  t = await createTestApp({ env: { BILLINGO_API_KEY: 'x', BILLINGO_API_URL: 'https://billingo.mock' } as any });
  t.sql.exec(`
    INSERT INTO groups (id, section, label) VALUES ('g_proj', 'in', 'Projektek'), ('g_ki', 'out', 'Működés');
    INSERT INTO leaves (id, group_id, label) VALUES
      ('l_minta', 'g_proj', 'Minta'), ('l_pelda', 'g_proj', 'Példa Bt'), ('l_domain', 'g_proj', 'Domain és tárhely'),
      ('l_irodaszer', 'g_ki', 'Irodaszer');
  `);
  return t;
}

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
    stubBillingo([{ id: 9001, invoice_number: 'MNT-2026-000101', partner: 'Minta Kft.', gross: 254_000, due: day(8) }]);
    const r = await syncBillingo(t!.env);
    expect(r).toEqual({ docs: 1, plans: 1 });
    const p = entry('b9001');
    expect(p).toMatchObject({ kind: 'plan', date: day(8), leaf_id: 'l_minta', amount: 254_000, bill_amount: 254_000, done: 0, source: 'billingo', ext_ref: 'billingo:9001' });
    expect(p.name).toContain('MNT-2026-000101');
    expect(doc(9001)).toMatchObject({ plan_id: 'b9001', payment_status: 'outstanding', gross: 254_000 });
  });

  it('a meglévő tervet állítja „kiszámlázottra” – nincs dupla bevétel, a terv összege és neve marad', async () => {
    await setup();
    plan('p_havi', 'l_minta', day(10), 254_000, 'Havi díj – 2026. november');
    stubBillingo([{ id: 9002, invoice_number: 'MNT-2026-000102', partner: 'Minta Kft.', gross: 254_000, due: day(8) }]);
    await syncBillingo(t!.env);
    expect(entry('b9002')).toBeUndefined();
    expect(entry('p_havi')).toMatchObject({ amount: 254_000, bill_amount: 254_000, ext_ref: 'billingo:9002', source: 'billingo', name: 'Havi díj – 2026. november', date: day(8) });
    expect(doc(9002).plan_id).toBe('p_havi');
    const open = entries("kind = 'plan' AND done = 0 AND leaf_id = 'l_minta'");
    expect(open.reduce((a, e) => a + e.amount, 0)).toBe(254_000);
  });

  it('eltérő összegű számla: a terv összege marad, a számla összege a bill_amount', async () => {
    await setup();
    plan('p_havi', 'l_minta', day(10), 300_000, 'Marketing tanácsadás');
    stubBillingo([{ id: 9003, invoice_number: 'MNT-2026-000103', partner: 'Minta Kft.', gross: 281_940, due: day(8) }]);
    await syncBillingo(t!.env);
    expect(entry('p_havi')).toMatchObject({ amount: 300_000, plan_amount: 300_000, bill_amount: 281_940, ext_ref: 'billingo:9003' });
  });

  it('ismételt szinkron nem dupláz (idempotens)', async () => {
    await setup();
    plan('p_havi', 'l_minta', day(10), 254_000, 'Havi díj');
    const docs = [
      { id: 9004, invoice_number: 'MNT-2026-000104', partner: 'Minta Kft.', gross: 254_000, due: day(8) },
      { id: 9005, invoice_number: 'PLD-2026-000017', partner: 'Példa Bt.', gross: 63_500, due: day(15) },
    ];
    stubBillingo(docs);
    await syncBillingo(t!.env);
    const before = entries();
    await syncBillingo(t!.env);
    await syncBillingo(t!.env);
    expect(entries()).toEqual(before.map((e) => ({ ...e, updated_at: expect.any(Number) })));
    expect(entries("ext_ref LIKE 'billingo:%'").length).toBe(2);
  });

  it('a Billingo szerint fizetett számla: tény a fizetés napjára, a terv lezárul és a tényhez kötődik', async () => {
    await setup();
    plan('p_havi', 'l_minta', day(-2), 254_000, 'Havi díj');
    const d: Doc = { id: 9006, invoice_number: 'MNT-2026-000106', partner: 'Minta Kft.', gross: 254_000, due: day(-2) };
    stubBillingo([d]);
    await syncBillingo(t!.env);
    stubBillingo([{ ...d, status: 'paid', paid_date: day(-1) }]);
    await syncBillingo(t!.env);
    const p = entry('p_havi');
    expect(p).toMatchObject({ done: 1, link_id: 'bp9006' });
    expect(entry('bp9006')).toMatchObject({ kind: 'actual', date: day(-1), amount: 254_000, leaf_id: 'l_minta', source: 'billingo', ext_ref: 'bpaid:9006' });
    // harmadik szinkron: nem hoz létre még egy tényt
    await syncBillingo(t!.env);
    expect(entries("kind = 'actual'").length).toBe(1);
  });

  it('fizetett számla, ha a tény már megvan (pl. xls import): ahhoz kötődik, nem lesz második tény', async () => {
    await setup();
    plan('p_havi', 'l_minta', day(-6), 254_000, 'Havi díj');
    plan('a_imp', 'l_minta', day(-3), 254_000, 'Minta', { kind: 'actual', source: 'import', ext_ref: 'imp:actual:x:1' });
    stubBillingo([{ id: 9007, invoice_number: 'MNT-2026-000107', partner: 'Minta Kft.', gross: 254_000, due: day(-6), status: 'paid', paid_date: day(-3) }]);
    await syncBillingo(t!.env);
    expect(entry('p_havi')).toMatchObject({ done: 1, link_id: 'a_imp', ext_ref: 'billingo:9007' });
    expect(entries("kind = 'actual'").map((e) => e.id)).toEqual(['a_imp']);
  });

  it('devizás számla forintban (árfolyammal)', async () => {
    await setup();
    stubBillingo([{ id: 9008, invoice_number: 'MNT-2026-000108', partner: 'Minta Kft.', gross: 1_000, currency: 'EUR', rate: 391.5, due: day(12) }]);
    await syncBillingo(t!.env);
    expect(entry('b9008')).toMatchObject({ amount: 391_500, bill_amount: 391_500 });
  });

  it('díjbekérő / kiadás típusú bizonylat nem lesz bevétel', async () => {
    await setup();
    stubBillingo([{ id: 9009, invoice_number: 'D-2026-1', partner: 'Minta Kft.', gross: 100_000, due: day(5), type: 'proforma' }]);
    await syncBillingo(t!.env);
    expect(entries()).toEqual([]);
  });

  it('sztornózott számla: a számlából lett terv törlődik', async () => {
    await setup();
    const d: Doc = { id: 9010, invoice_number: 'MNT-2026-000110', partner: 'Minta Kft.', gross: 120_000, due: day(9) };
    stubBillingo([d]);
    await syncBillingo(t!.env);
    expect(entry('b9010')).toBeDefined();
    stubBillingo([{ ...d, cancelled: true, status: 'none' }]);
    await syncBillingo(t!.env);
    expect(entry('b9010')).toBeUndefined();
    expect(doc(9010)).toMatchObject({ cancelled: 1 });
  });

  it('sztornózott számla a saját (előre felvett) tervhez kötve: a terv NEM törlődik, újra „nincs kiszámlázva” lesz', async () => {
    await setup();
    plan('p_havi', 'l_minta', day(10), 254_000, 'Havi díj – 2026. november');
    const d: Doc = { id: 9011, invoice_number: 'MNT-2026-000111', partner: 'Minta Kft.', gross: 254_000, due: day(8) };
    stubBillingo([d]);
    await syncBillingo(t!.env);
    expect(entry('p_havi').ext_ref).toBe('billingo:9011');
    // a számlát sztornózzák, és helyette újat állítanak ki
    stubBillingo([
      { ...d, cancelled: true, status: 'none' },
      { id: 9012, invoice_number: 'MNT-2026-000112', partner: 'Minta Kft.', gross: 254_000, due: day(8) },
    ]);
    await syncBillingo(t!.env);
    const p = entry('p_havi');
    expect(p).toBeDefined();
    expect(p).toMatchObject({ amount: 254_000, name: 'Havi díj – 2026. november', done: 0 });
    // az új számla ugyanehhez a tervhez kötődik, nincs külön sor és nincs dupla bevétel
    expect(p.ext_ref).toBe('billingo:9012');
    expect(entry('b9012')).toBeUndefined();
    expect(doc(9011).plan_id).toBeNull();
    expect(doc(9012).plan_id).toBe('p_havi');
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
    stubBillingo([{ id: 9101, invoice_number: 'ALF-2026-000057', partner: 'Alfa Tanácsadó Kft.', gross: 102_235, due: day(5) }]);
    await syncBillingo(t!.env);
    expect(entry('p_gamma')).toMatchObject({ ext_ref: null, bill_amount: null, amount: 48_387, done: 0 });
    expect(entry('b9101')).toMatchObject({ leaf_id: 'l_domain', amount: 102_235 });
  });

  it('azonos összegnél sem viszi el a másik ügyfél tervét, a sajátját választja', async () => {
    await sharedLeaf();
    plan('p_beta', 'l_domain', day(2), 48_260, 'Beta – 2026. november');
    plan('p_alfa', 'l_domain', day(9), 48_260, 'Alfa – tárhely – 2026. november');
    stubBillingo([{ id: 9102, invoice_number: 'ALF-2026-000058', partner: 'Alfa Tanácsadó Kft.', gross: 48_260, due: day(3) }]);
    await syncBillingo(t!.env);
    expect(entry('p_alfa').ext_ref).toBe('billingo:9102');
    expect(entry('p_beta').ext_ref).toBeNull();
  });

  it('a kategória nevére szóló (általános) tervhez köthető', async () => {
    await sharedLeaf();
    plan('p_dom', 'l_domain', day(4), 48_260, 'Domain és tárhely – 2026. november');
    stubBillingo([{ id: 9103, invoice_number: 'BET-2026-000003', partner: 'Beta Ingatlan Kft.', gross: 48_260, due: day(3) }]);
    await syncBillingo(t!.env);
    expect(entry('p_dom').ext_ref).toBe('billingo:9103');
  });

  it('a saját partner-sorban az összegtől független terv-kötés megmarad (pl. „Havi díj”)', async () => {
    await setup();
    plan('p_havi', 'l_minta', day(6), 1_497_000, 'Marketing tanácsadás – 2026. november');
    stubBillingo([{ id: 9104, invoice_number: 'MNT-2026-000120', partner: 'Minta Kft.', gross: 1_005_408, due: day(8) }]);
    await syncBillingo(t!.env);
    expect(entry('p_havi')).toMatchObject({ ext_ref: 'billingo:9104', amount: 1_497_000, bill_amount: 1_005_408 });
  });
});

describe('Utólagos összevonás (reconcileInvoicePlans) – számla-sor + később felvett saját terv', () => {
  it('a később felvett saját tervhez kerül a számla-sor: egy sor marad, a terv összege és neve megmarad', async () => {
    await setup();
    stubBillingo([{ id: 9201, invoice_number: 'MNT-2026-000130', partner: 'Minta Kft.', gross: 381_000, due: day(7) }]);
    await syncBillingo(t!.env);
    plan('p_seo', 'l_minta', day(9), 375_000, 'SEO – 2026. november');
    const { reconcileInvoicePlans } = await import('../../src/server/app/billingo');
    expect(await reconcileInvoicePlans(t!.env)).toBe(1);
    expect(entry('b9201')).toBeUndefined();
    expect(entry('p_seo')).toMatchObject({ ext_ref: 'billingo:9201', amount: 375_000, bill_amount: 381_000, name: 'SEO – 2026. november' });
    expect(doc(9201).plan_id).toBe('p_seo');
  });

  it('több ügyfeles sorban a másik ügyfél tervéhez nem vonja össze', async () => {
    await setup();
    t!.sql.exec(`INSERT INTO partner_rules (pattern, leaf_id, hits, updated_at) VALUES ('alfa tanacsado', 'l_domain', 1, 1);
      INSERT INTO leaves (id, group_id, label) VALUES ('l_gamma', 'g_proj', 'GammaHomes');`);
    stubBillingo([{ id: 9202, invoice_number: 'ALF-2026-000060', partner: 'Alfa Tanácsadó Kft.', gross: 102_235, due: day(5) }]);
    await syncBillingo(t!.env);
    plan('p_gamma', 'l_domain', day(6), 48_387, 'GammaHomes – 2026. november');
    const { reconcileInvoicePlans } = await import('../../src/server/app/billingo');
    expect(await reconcileInvoicePlans(t!.env)).toBe(0);
    expect(entry('b9202')).toBeDefined();
    expect(entry('p_gamma').ext_ref).toBeNull();
  });
});
