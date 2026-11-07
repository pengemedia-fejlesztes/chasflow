// NAV bejövő számlák újrapárosítása (rematchNav): terv nélküli számla riasztás, „tervezett” / „fizetve” állapot.
import { afterEach, describe, expect, it } from 'vitest';
import { rematchNav, storeDigests, type NavDigest } from '../../src/server/app/nav';
import { createTestApp, type TestApp } from '../helpers/app';

let t: TestApp | undefined;
afterEach(() => {
  t?.close();
  t = undefined;
});
const day = (n: number) => new Date(Date.now() + n * 86400_000).toISOString().slice(0, 10);
const navDoc = (n: string, gross: number, issue: string, pay: string, name: string, tax: string): NavDigest => ({
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
  originalInvoiceNumber: '',
});
async function setup() {
  t = await createTestApp();
  t.sql.exec(`
    INSERT INTO groups (id, section, label) VALUES ('g_ki', 'out', 'Szolgáltatások');
    INSERT INTO leaves (id, group_id, label) VALUES ('l_tarhely', 'g_ki', 'Domain-Tárhely'), ('l_konyv', 'g_ki', 'Könyvelés');
    INSERT INTO partner_rules (pattern, leaf_id, hits, updated_at) VALUES ('szerverpark', 'l_tarhely', 5, 1), ('webmuhely', 'l_tarhely', 2, 1), ('konyvelo iroda', 'l_konyv', 3, 1);
  `);
  return t;
}
function entry(id: string, kind: string, leaf: string, date: string, amount: number, name: string, extra: Record<string, unknown> = {}) {
  const row = { id, kind, date, leaf_id: leaf, name, amount, done: 0, tentative: 0, source: 'manual', updated_at: 1, ...extra };
  const cols = Object.keys(row);
  t!.sql.prepare(`INSERT INTO entries (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`).run(...(Object.values(row) as any[]));
}
const nav = (id: string) => t!.sql.prepare('SELECT status, plan_id, actual_id FROM nav_invoices WHERE id = ?').get(id) as any;

describe('NAV – több szállítós kiadási sor', () => {
  it('a másik szállító nevére szóló tervhez nem köti a számlát → terv nélküli riasztás', async () => {
    await setup();
    // a Szerverpark Zrt. havi terve; a Webműhely Kft. számlája ugyanebbe a sorba esik
    await storeDigests(t!.env, [navDoc('SZP-2026/1001', 10_236, day(-30), day(-22), 'Szerverpark Zrt.', '11111111')]);
    t!.sql.exec("UPDATE nav_invoices SET status = 'paid'"); // korábbi, már rendezett számla (csak a név ismert)
    entry('p_szp', 'plan', 'l_tarhely', day(3), -8_255, 'Szerverpark – 2026. november');
    await storeDigests(t!.env, [navDoc('WM-2026-000170', 27_630, day(-1), day(7), 'Webműhely Kft.', '22222222')]);
    const r = await rematchNav(t!.env);
    expect(nav('nav:22222222:WM-2026-000170')).toMatchObject({ status: 'new', plan_id: null });
    expect(r.unplanned).toBeGreaterThanOrEqual(1);
  });

  it('a saját nevére szóló terv a számla terve', async () => {
    await setup();
    await storeDigests(t!.env, [navDoc('SZP-2026/1002', 10_236, day(-30), day(-22), 'Szerverpark Zrt.', '11111111')]);
    t!.sql.exec("UPDATE nav_invoices SET status = 'paid'"); // korábbi, már rendezett számla (csak a név ismert)
    entry('p_szp', 'plan', 'l_tarhely', day(3), -10_236, 'Szerverpark – 2026. november');
    await storeDigests(t!.env, [navDoc('SZP-2026/1101', 10_236, day(-2), day(4), 'Szerverpark Zrt.', '11111111')]);
    await rematchNav(t!.env);
    expect(nav('nav:11111111:SZP-2026/1101')).toMatchObject({ status: 'planned', plan_id: 'p_szp' });
  });

  it('a másik szállító banki ténye nem „fizeti ki” a számlát', async () => {
    await setup();
    await storeDigests(t!.env, [navDoc('SZP-2026/1003', 10_236, day(-30), day(-22), 'Szerverpark Zrt.', '11111111')]);
    t!.sql.exec("UPDATE nav_invoices SET status = 'paid'"); // korábbi, már rendezett számla (csak a név ismert)
    entry('a_wm', 'actual', 'l_tarhely', day(-1), -10_236, 'Webműhely Kft.', { source: 'bank', ext_ref: 'bank:t1' });
    await storeDigests(t!.env, [navDoc('SZP-2026/1102', 10_236, day(-3), day(5), 'Szerverpark Zrt.', '11111111')]);
    await rematchNav(t!.env);
    expect(nav('nav:11111111:SZP-2026/1102').status).not.toBe('paid');
  });
});

describe('NAV – törölt terv', () => {
  it('a „tervezett” számla terve törlődött → újra terv nélküli, és a már kifizetett tényhez kötődik', async () => {
    await setup();
    await storeDigests(t!.env, [navDoc('KI-2026-515', 36_830, day(-20), day(-12), 'Könyvelő Iroda Kft.', '33333333')]);
    t!.sql.exec("UPDATE nav_invoices SET status = 'planned', plan_id = 'n_torolt_0', leaf_id = 'l_konyv'");
    entry('a_konyv', 'actual', 'l_konyv', day(-10), -36_830, 'Könyvelési díj', { source: 'import' });
    await rematchNav(t!.env);
    expect(nav('nav:33333333:KI-2026-515')).toMatchObject({ status: 'paid', actual_id: 'a_konyv', plan_id: null });
  });
  it('a meglévő tervű „tervezett” számla érintetlen', async () => {
    await setup();
    entry('p_konyv', 'plan', 'l_konyv', day(5), -36_830, 'Könyvelési díj');
    await storeDigests(t!.env, [navDoc('KI-2026-600', 36_830, day(-2), day(6), 'Könyvelő Iroda Kft.', '33333333')]);
    t!.sql.exec("UPDATE nav_invoices SET status = 'planned', plan_id = 'p_konyv', leaf_id = 'l_konyv'");
    await rematchNav(t!.env);
    expect(nav('nav:33333333:KI-2026-600')).toMatchObject({ status: 'planned', plan_id: 'p_konyv' });
  });
});
