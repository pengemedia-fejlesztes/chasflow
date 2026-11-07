// A teljes lánc a valódi backenden, a közös Billingo- és NAV-mockkal: terv → Billingo-számla (kimenő) / NAV-számla
// (bejövő) → banki tétel → tény, és a kötés (link_id) minden lépés után. Szándék (README, LinkChain.tsx, bank.ts):
// a terv összege nem változik, a tény a tervhez kötődik (plan.link_id), egy bevétel / kiadás egyszer számít.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { syncBillingo } from '../../src/server/app/billingo';
import { approve, payBillingoFromBank } from '../../src/server/app/bank';
import { resolveNav, syncNav } from '../../src/server/app/nav';
import { actualOf, planLinks } from '../../src/client/LinkChain';
import { createTestApp, type TestApp } from '../helpers/app';
import { installMocks, mockBillingo, mockNav, type BillingoMock, type NavMock } from '../helpers/mocks';

let t: TestApp | undefined;
let billingo: BillingoMock;
let nav: NavMock;
afterEach(() => {
  t?.close();
  t = undefined;
  vi.unstubAllGlobals();
});

const day = (n: number) => new Date(Date.now() + n * 86400_000).toISOString().slice(0, 10);

async function setup() {
  billingo = mockBillingo();
  nav = mockNav();
  const ext = installMocks(billingo, nav);
  t = await createTestApp({ env: ext.env as any });
  t.sql.exec(`
    INSERT INTO groups (id, section, label) VALUES ('g_proj', 'in', 'Projektek'), ('g_ki', 'out', 'Szolgáltatások');
    INSERT INTO leaves (id, group_id, label) VALUES ('l_minta', 'g_proj', 'Minta'), ('l_pelda', 'g_proj', 'Példa Bt'),
      ('l_tarhely', 'g_ki', 'Tárhely Szolgáltató'), ('l_konyv', 'g_ki', 'Könyvelés');
    INSERT INTO bank_accounts (id, provider, bank_name, label) VALUES ('acc1', 'manual', 'Minta Bank', 'Folyószámla');
  `);
  return t;
}
function plan(id: string, leaf: string, date: string, amount: number, name: string, extra: Record<string, unknown> = {}) {
  const row = { id, kind: 'plan', date, leaf_id: leaf, name, amount, done: 0, tentative: 0, source: 'manual', updated_at: 1, ...extra };
  const cols = Object.keys(row);
  t!.sql.prepare(`INSERT INTO entries (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`).run(...(Object.values(row) as any[]));
}
function tx(id: string, date: string, amount: number, partner: string, memo: string) {
  t!.sql
    .prepare("INSERT INTO bank_tx (id, account_id, ext_id, date, amount, partner, memo, status, created_at) VALUES (?, 'acc1', ?, ?, ?, ?, ?, 'new', 1)")
    .run(id, id, date, amount, partner, memo);
}
const entry = (id: string) => t!.sql.prepare('SELECT * FROM entries WHERE id = ?').get(id) as any;
const all = (where = '1=1') => t!.sql.prepare(`SELECT * FROM entries WHERE ${where} ORDER BY id`).all() as any[];
const bankTx = (id: string) => t!.sql.prepare('SELECT * FROM bank_tx WHERE id = ?').get(id) as any;
const navRow = (id: string) => t!.sql.prepare('SELECT * FROM nav_invoices WHERE id = ?').get(id) as any;

describe('bevétel: terv → Billingo-számla → fizetve → banki jóváírás → tény', () => {
  it('a lánc végig összekötve marad, és a bevétel egyszer számít', async () => {
    await setup();
    plan('p_havi', 'l_minta', day(-4), 254_000, 'Havi díj – 2026. november');
    billingo.addDocument({ id: 9301, number: 'MNT-2026-000201', partner: 'Minta Kft.', gross: 254_000, dueDate: day(-4), invoiceDate: day(-10) });
    await syncBillingo(t!.env);
    // a Billingóban fizetettre állították
    billingo.pay(9301, { date: day(-2) });
    await syncBillingo(t!.env);
    expect(entry('p_havi')).toMatchObject({ done: 1, link_id: 'bp9301' });
    // megjön a banki jóváírás: magától a „fizetve” tényhez kapcsolódik (nem lesz második tény)
    tx('tx1', day(-2), 254_000, 'MINTA KFT', 'MNT-2026-000201 számla kiegyenlítése');
    await payBillingoFromBank(t!.env);
    expect(bankTx('tx1')).toMatchObject({ status: 'approved', actual_id: 'bp9301' });
    expect(entry('bp9301')).toMatchObject({ kind: 'actual', source: 'bank', ext_ref: 'bank:tx1', amount: 254_000 });
    const ents = all();
    expect(ents.filter((e) => e.kind === 'actual').length).toBe(1);
    // a kliens lánc-nézete (LinkChain) ugyanezt látja
    const p = ents.find((e) => e.id === 'p_havi');
    expect(actualOf({ entries: ents }, p)?.id).toBe('bp9301');
    expect(planLinks(ents)).toEqual([expect.objectContaining({ diff: 0 })]);
  });

  it('banki jóváírás → az app a Billingóban is fizetettre állítja a számlát (PUT payments), a terv lezárul', async () => {
    await setup();
    billingo.addDocument({ id: 9303, number: 'MNT-2026-000203', partner: 'Minta Kft.', gross: 63_500, dueDate: day(2), invoiceDate: day(-6) });
    await syncBillingo(t!.env);
    tx('tx4', day(-1), 63_500, 'MINTA KFT', 'MNT-2026-000203');
    await payBillingoFromBank(t!.env);
    expect(billingo.payments).toEqual([{ documentId: 9303, payments: [{ date: day(-1), price: 63_500, payment_method: 'wire_transfer' }], at: expect.any(Number) }]);
    expect(t!.sql.prepare('SELECT payment_status, paid_by_tx FROM billingo_docs WHERE id = 9303').get()).toEqual({ payment_status: 'paid', paid_by_tx: 'tx4' });
    const p = entry('b9303');
    expect(p.done).toBe(1);
    expect(entry(p.link_id)).toMatchObject({ kind: 'actual', amount: 63_500, ext_ref: 'bank:tx4' });
    expect(all("kind = 'actual'").length).toBe(1);
  });

  it('más partner azonos összegű jóváírása nem viszi el a „fizetve” tényt, a választott terv lezárul', async () => {
    await setup();
    plan('p_minta', 'l_minta', day(-4), 100_000, 'Havi díj');
    plan('p_pelda', 'l_pelda', day(-3), 100_000, 'Példa Bt – 2026. november');
    billingo.addDocument({ id: 9302, number: 'MNT-2026-000202', partner: 'Minta Kft.', gross: 100_000, dueDate: day(-4), status: 'paid', paidDate: day(-3) });
    await syncBillingo(t!.env);
    expect(entry('p_minta')).toMatchObject({ done: 1, link_id: 'bp9302' });
    // a Példa Bt. utalása – a felhasználó a Példa Bt. tervéhez hagyja jóvá
    tx('tx2', day(-2), 100_000, 'PELDA BT', 'novemberi díj');
    await approve(t!.env, t!.userId, [{ id: 'tx2', leaf_id: 'l_pelda', plan_id: 'p_pelda' }]);
    expect(entry('p_pelda')).toMatchObject({ done: 1, link_id: 'atx2' });
    expect(entry('atx2')).toMatchObject({ kind: 'actual', leaf_id: 'l_pelda', amount: 100_000 });
    // a Minta Kft. „fizetve” ténye érintetlen, a saját banki tételére vár
    expect(entry('bp9302')).toMatchObject({ source: 'billingo', ext_ref: 'bpaid:9302', leaf_id: 'l_minta' });
  });
});

describe('kiadás: NAV bejövő számla → terv → banki terhelés → tény', () => {
  it('terv nélküli számla → riasztás (new); besorolás után terv; a banki terhelés a tervet zárja', async () => {
    await setup();
    nav.addInvoice({ number: 'TSZ-2026/0815', supplierName: 'Tárhely Szolgáltató Kft.', supplierTax: '12345678-2-41', issueDate: day(-6), paymentDate: day(2), gross: 12_700 });
    expect(await syncNav(t!.env)).toEqual({ invoices: 1, unplanned: 1 });
    const id = 'nav:12345678:TSZ-2026/0815';
    expect(navRow(id)).toMatchObject({ status: 'new', gross: -12_700, net: -10_000 });
    await resolveNav(t!.env, t!.userId, { id, action: 'assign', leaf_id: 'l_tarhely' });
    const n = navRow(id);
    expect(n).toMatchObject({ status: 'planned', leaf_id: 'l_tarhely' });
    const p = entry(n.plan_id);
    expect(p).toMatchObject({ kind: 'plan', amount: -12_700, leaf_id: 'l_tarhely', ext_ref: id, done: 0 });
    tx('tx3', day(1), -12_700, 'TARHELY SZOLGALTATO KFT', 'TSZ-2026/0815');
    await approve(t!.env, t!.userId, [{ id: 'tx3', leaf_id: 'l_tarhely', plan_id: p.id }]);
    expect(entry(p.id)).toMatchObject({ done: 1, link_id: 'atx3' });
    expect(entry('atx3')).toMatchObject({ amount: -12_700, link_id: p.id });
    // újabb szinkron: nincs új terv nélküli számla
    expect((await syncNav(t!.env)).unplanned).toBe(0);
  });

  it('már kifizetett számla (banki tény megvan) → „fizetve”, nem riaszt', async () => {
    await setup();
    t!.sql.exec("INSERT INTO partner_rules (pattern, leaf_id, hits, updated_at) VALUES ('konyvelo iroda', 'l_konyv', 3, 1)");
    plan('a_konyv', 'l_konyv', day(-3), -36_830, 'Könyvelő Iroda Kft.', { kind: 'actual', source: 'bank', ext_ref: 'bank:x' });
    nav.addInvoice({ number: 'KI-2026-515', supplierName: 'Könyvelő Iroda Kft.', supplierTax: '87654321-2-13', issueDate: day(-8), paymentDate: day(-1), gross: 36_830 });
    expect((await syncNav(t!.env)).unplanned).toBe(0);
    expect(navRow('nav:87654321:KI-2026-515')).toMatchObject({ status: 'paid', actual_id: 'a_konyv' });
  });

  it('nyitott tervhez illő számla → „tervezett”', async () => {
    await setup();
    plan('p_konyv', 'l_konyv', day(4), -36_830, 'Könyvelési díj – 2026. november');
    t!.sql.exec("INSERT INTO partner_rules (pattern, leaf_id, hits, updated_at) VALUES ('konyvelo iroda', 'l_konyv', 3, 1)");
    nav.addInvoice({ number: 'KI-2026-516', supplierName: 'Könyvelő Iroda Kft.', supplierTax: '87654321-2-13', issueDate: day(-2), paymentDate: day(5), gross: 36_830 });
    expect((await syncNav(t!.env)).unplanned).toBe(0);
    expect(navRow('nav:87654321:KI-2026-516')).toMatchObject({ status: 'planned', plan_id: 'p_konyv' });
  });

  it('sztornó számla: az eredeti és a sztornó is kikerül a riasztásból', async () => {
    await setup();
    nav.addInvoice({ number: 'TSZ-2026/0900', supplierName: 'Tárhely Szolgáltató Kft.', supplierTax: '12345678-2-41', issueDate: day(-9), paymentDate: day(-1), gross: 25_400 });
    await syncNav(t!.env);
    nav.addInvoice({ number: 'TSZ-2026/0901', supplierName: 'Tárhely Szolgáltató Kft.', supplierTax: '12345678-2-41', issueDate: day(-5), gross: -25_400, operation: 'STORNO', originalInvoiceNumber: 'TSZ-2026/0900' });
    expect((await syncNav(t!.env)).unplanned).toBe(0);
    const rows = t!.sql.prepare('SELECT invoice_number, status FROM nav_invoices ORDER BY invoice_number').all();
    expect(rows).toEqual([
      { invoice_number: 'TSZ-2026/0900', status: 'ignored' },
      { invoice_number: 'TSZ-2026/0901', status: 'ignored' },
    ]);
  });
});

describe('NAV szinkron – lekérdezés és hibakezelés', () => {
  it('első szinkron: 120 nap, 35 napos ablakokban, lapozva; minden számla bekerül', async () => {
    await setup();
    nav.setPageSize(2);
    for (let i = 0; i < 5; i++)
      nav.addInvoice({ number: `IR-2026-${100 + i}`, supplierName: 'Irodaszer Bolt Kft.', supplierTax: '55555555-2-42', issueDate: day(-3 - i), paymentDate: day(5), gross: 12_700 + i });
    nav.addInvoice({ number: 'IR-2026-OLD', supplierName: 'Irodaszer Bolt Kft.', supplierTax: '55555555-2-42', issueDate: day(-100), paymentDate: day(-90), gross: 5_080 });
    const r = await syncNav(t!.env);
    expect(r.invoices).toBe(6);
    expect((t!.sql.prepare('SELECT count(*) AS n FROM nav_invoices').get() as any).n).toBe(6);
    const digests = nav.requests.filter((q) => q.op === 'queryInvoiceDigest');
    expect(digests[0].from).toBe(day(-120));
    expect(digests.every((q) => (Date.parse(q.to!) - Date.parse(q.from!)) / 86400_000 <= 34)).toBe(true);
    expect(digests.some((q) => q.page === 3)).toBe(true);
  });

  it('egyszerűsített számla (0 Ft a kivonatban): a bruttó a számla teljes adatából (tömörítve is)', async () => {
    await setup();
    nav.addInvoice({
      number: 'BLK-2026-77',
      supplierName: 'Üzemanyag Kút Kft.',
      supplierTax: '66666666-2-13',
      issueDate: day(-2),
      paymentMethod: 'CARD',
      simplified: true,
      compressed: true,
      lines: [{ description: 'Benzin 95', net: 15_000, vatRate: 0.27 }],
    });
    await syncNav(t!.env);
    expect(navRow('nav:66666666:BLK-2026-77')).toMatchObject({ gross: -19_050 });
  });

  it('hibás technikai felhasználó → érthető NAV hiba, elmentve a beállításokba', async () => {
    await setup();
    nav.failNav('INVALID_SECURITY_USER', 'Helytelen authentikációs adatok!');
    await expect(syncNav(t!.env)).rejects.toThrow(/INVALID_SECURITY_USER/);
    const err = t!.sql.prepare("SELECT value FROM settings WHERE key = 'nav_last_error'").get() as any;
    expect(err.value).toMatch(/INVALID_SECURITY_USER/);
  });

  it('rossz aláírókulcs → a mock a NAV aláírás-hibáját adja', async () => {
    await setup();
    await expect(syncNav({ ...t!.env, NAV_SIGN_KEY: 'rossz-kulcs' } as any)).rejects.toThrow(/INVALID_REQUEST_SIGNATURE/);
  });

  it('átmeneti 500 / hálózati hiba: egyszer újrapróbálja, és sikerül', async () => {
    await setup();
    nav.addInvoice({ number: 'TSZ-2026/1000', supplierName: 'Tárhely Szolgáltató Kft.', supplierTax: '12345678-2-41', issueDate: day(-1), gross: 12_700 });
    nav.fail(500);
    expect((await syncNav(t!.env)).invoices).toBe(1);
    nav.fail('timeout');
    expect((await syncNav(t!.env)).invoices).toBe(1);
  });

  it('tartós hiba (502 kétszer) → érthető hibaüzenet, a „legutóbbi dátum” nem lép előre', async () => {
    await setup();
    nav.fail(502, { times: 2 });
    await expect(syncNav(t!.env)).rejects.toThrow(/NAV hiba: HTTP 502/);
    expect(t!.sql.prepare("SELECT value FROM settings WHERE key = 'nav_last_date'").get()).toBeUndefined();
  });
});
