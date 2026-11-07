// A teljes lánc a valódi backenden: terv → Billingo-számla (kimenő) / NAV-számla (bejövő) → banki tétel → tény,
// és a kötés (link_id) minden lépés után. Szándék (README, LinkChain.tsx, bank.ts): a terv összege nem változik,
// a tény a tervhez kötődik (plan.link_id), egy bevétel / kiadás egyszer számít.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { syncBillingo } from '../../src/server/app/billingo';
import { approve, payBillingoFromBank } from '../../src/server/app/bank';
import { rematchNav, resolveNav, storeDigests, type NavDigest } from '../../src/server/app/nav';
import { actualOf, planLinks } from '../../src/client/LinkChain';
import { createTestApp, type TestApp } from '../helpers/app';

let t: TestApp | undefined;
afterEach(() => {
  t?.close();
  t = undefined;
  vi.unstubAllGlobals();
});

const day = (n: number) => new Date(Date.now() + n * 86400_000).toISOString().slice(0, 10);

async function setup() {
  t = await createTestApp({ env: { BILLINGO_API_KEY: 'x', BILLINGO_API_URL: 'https://billingo.mock' } as any });
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

function stubBillingo(docs: any[]) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string | URL | Request) => {
      if (String(url).startsWith('https://billingo.mock/documents?')) return Response.json({ data: docs, current_page: 1, last_page: 1 });
      throw new Error('váratlan hívás: ' + url);
    }),
  );
}
const bdoc = (id: number, number: string, partner: string, gross: number, due: string, extra: Record<string, unknown> = {}) => ({
  id,
  invoice_number: number,
  type: 'invoice',
  cancelled: false,
  payment_status: 'outstanding',
  gross_total: gross,
  currency: 'HUF',
  invoice_date: day(-10),
  due_date: due,
  partner: { name: partner },
  ...extra,
});

describe('bevétel: terv → Billingo-számla → fizetve → banki jóváírás → tény', () => {
  it('a lánc végig összekötve marad, és a bevétel egyszer számít', async () => {
    await setup();
    plan('p_havi', 'l_minta', day(-4), 254_000, 'Havi díj – 2026. november');
    stubBillingo([bdoc(9301, 'MNT-2026-000201', 'Minta Kft.', 254_000, day(-4))]);
    await syncBillingo(t!.env);
    // a Billingóban fizetettre állították
    stubBillingo([bdoc(9301, 'MNT-2026-000201', 'Minta Kft.', 254_000, day(-4), { payment_status: 'paid', paid_date: day(-2) })]);
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

  it('más partner azonos összegű jóváírása nem viszi el a „fizetve” tényt, a választott terv lezárul', async () => {
    await setup();
    plan('p_minta', 'l_minta', day(-4), 100_000, 'Havi díj');
    plan('p_pelda', 'l_pelda', day(-3), 100_000, 'Példa Bt – 2026. november');
    stubBillingo([bdoc(9302, 'MNT-2026-000202', 'Minta Kft.', 100_000, day(-4), { payment_status: 'paid', paid_date: day(-3) })]);
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
  const navDoc = (n: string, gross: number, issue: string, pay: string, name = 'Tárhely Szolgáltató Kft.', tax = '12345678'): NavDigest => ({
    invoiceNumber: n,
    invoiceOperation: 'CREATE',
    supplierTaxNumber: tax,
    supplierName: name,
    invoiceIssueDate: issue,
    invoiceDeliveryDate: issue,
    paymentDate: pay,
    paymentMethod: 'TRANSFER',
    currency: 'HUF',
    net: Math.round(gross / 1.27),
    gross,
  } as NavDigest);

  it('terv nélküli számla → riasztás (new); besorolás után terv; a banki terhelés a tervet zárja, a lánc látszik', async () => {
    await setup();
    await storeDigests(t!.env, [navDoc('TSZ-2026/0815', 12_700, day(-6), day(2))]);
    expect((await rematchNav(t!.env)).unplanned).toBe(1);
    const id = 'nav:12345678:TSZ-2026/0815';
    await resolveNav(t!.env, t!.userId, { id, action: 'assign', leaf_id: 'l_tarhely' });
    const nav = t!.sql.prepare('SELECT * FROM nav_invoices WHERE id = ?').get(id) as any;
    expect(nav).toMatchObject({ status: 'planned', leaf_id: 'l_tarhely' });
    const p = entry(nav.plan_id);
    expect(p).toMatchObject({ kind: 'plan', amount: -12_700, leaf_id: 'l_tarhely', ext_ref: id, done: 0 });
    tx('tx3', day(1), -12_700, 'TARHELY SZOLGALTATO KFT', 'TSZ-2026/0815');
    await approve(t!.env, t!.userId, [{ id: 'tx3', leaf_id: 'l_tarhely', plan_id: p.id }]);
    expect(entry(p.id)).toMatchObject({ done: 1, link_id: 'atx3' });
    expect(entry('atx3')).toMatchObject({ amount: -12_700, link_id: p.id });
    // nincs új terv nélküli számla
    expect((await rematchNav(t!.env)).unplanned).toBe(0);
  });

  it('már kifizetett számla (banki tény megvan) → „fizetve”, nem riaszt', async () => {
    await setup();
    plan('a_konyv', 'l_konyv', day(-3), -36_830, 'Könyvelő Iroda Kft.', { kind: 'actual', source: 'bank', ext_ref: 'bank:x' });
    await storeDigests(t!.env, [navDoc('KI-2026-515', 36_830, day(-8), day(-1), 'Könyvelő Iroda Kft.', '87654321')]);
    expect((await rematchNav(t!.env)).unplanned).toBe(0);
    expect(t!.sql.prepare("SELECT status, actual_id FROM nav_invoices WHERE id = 'nav:87654321:KI-2026-515'").get()).toMatchObject({
      status: 'paid',
      actual_id: 'a_konyv',
    });
  });

  it('nyitott tervhez illő számla → „tervezett”, a terv számlaszáma a banki párosításhoz', async () => {
    await setup();
    plan('p_konyv', 'l_konyv', day(4), -36_830, 'Könyvelési díj – 2026. november');
    t!.sql.exec("INSERT INTO partner_rules (pattern, leaf_id, hits, updated_at) VALUES ('konyvelo iroda', 'l_konyv', 3, 1)");
    await storeDigests(t!.env, [navDoc('KI-2026-516', 36_830, day(-2), day(5), 'Könyvelő Iroda Kft.', '87654321')]);
    expect((await rematchNav(t!.env)).unplanned).toBe(0);
    expect(t!.sql.prepare("SELECT status, plan_id FROM nav_invoices WHERE id = 'nav:87654321:KI-2026-516'").get()).toMatchObject({
      status: 'planned',
      plan_id: 'p_konyv',
    });
  });

  it('sztornó számla: az eredeti kikerül a riasztásból', async () => {
    await setup();
    await storeDigests(t!.env, [navDoc('TSZ-2026/0900', 25_400, day(-9), day(-1))]);
    await storeDigests(t!.env, [{ ...navDoc('TSZ-2026/0901', -25_400, day(-5), day(-5)), invoiceOperation: 'STORNO', originalInvoiceNumber: 'TSZ-2026/0900' }]);
    const rows = t!.sql.prepare('SELECT invoice_number, status FROM nav_invoices ORDER BY invoice_number').all();
    expect(rows).toEqual([
      { invoice_number: 'TSZ-2026/0900', status: 'ignored' },
      { invoice_number: 'TSZ-2026/0901', status: 'ignored' },
    ]);
  });
});
