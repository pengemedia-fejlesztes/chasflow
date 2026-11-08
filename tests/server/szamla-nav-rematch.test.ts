// NAV bejövő számlák újrapárosítása (rematchNav): terv nélküli számla riasztás, „tervezett” / „fizetve” állapot.
import { afterEach, describe, expect, it } from 'vitest';
import { rematchNav, storeDigests, type NavDigest } from '../../src/server/app/nav';
import { fixLinkedLeaves, settleNavPlans } from '../../src/server/app/bank';
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

describe('NAV – „havonta tervbe”, ha a szállítónak már van havi terve', () => {
  const plans = () => t!.sql.prepare("SELECT id, date, amount, series_id FROM entries WHERE kind = 'plan' ORDER BY date, id").all() as any[];
  const series = () => t!.sql.prepare('SELECT id FROM series').all() as any[];

  it('a 2. számla a meglévő sorozat azonos havi tervéhez kötődik, nem indul új 12 havi sorozat', async () => {
    await setup();
    // októberi számla → havonta tervbe (12 hónap)
    await storeDigests(t!.env, [navDoc('KI-2026-448', 36_830, day(-36), day(-28), 'Könyvelő Iroda Kft.', '33333333')]);
    expect((await t!.post('/api/nav/resolve', { id: 'nav:33333333:KI-2026-448', action: 'recurring', leaf_id: 'l_konyv', months: 12 })).status).toBe(200);
    expect(plans()).toHaveLength(12);
    // a novemberi számla is terv nélküliként jön (pl. a szinkron párosítása előtt), a felhasználó ismét „havonta tervbe”-t választ
    await storeDigests(t!.env, [navDoc('KI-2026-515', 36_830, day(-6), day(2), 'Könyvelő Iroda Kft.', '33333333')]);
    const r = await t!.post('/api/nav/resolve', { id: 'nav:33333333:KI-2026-515', action: 'recurring', leaf_id: 'l_konyv', months: 12 });
    expect(r.status).toBe(200);
    expect(plans()).toHaveLength(12);
    expect(series()).toHaveLength(1);
    const second = plans()[1];
    expect(nav('nav:33333333:KI-2026-515')).toMatchObject({ status: 'planned', plan_id: second.id });
    expect(r.data.attached).toMatchObject({ id: second.id });
    // a visszavonás csak a számla kötését bontja, a meglévő sorozat terve megmarad
    expect((await t!.post('/api/nav/resolve', { id: 'nav:33333333:KI-2026-515', action: 'reopen' })).status).toBe(200);
    expect(nav('nav:33333333:KI-2026-515')).toMatchObject({ status: 'new', plan_id: null });
    expect(plans()).toHaveLength(12);
  });

  it('a havi terv teljesült hónapját kihagyja: a számla hónapjának szabad tervéhez kötődik', async () => {
    await setup();
    // sorozat nélküli, importált havi tervek a szállító nevére; az októberit már egy banki tény lezárta
    entry('i_okt', 'plan', 'l_konyv', day(-25), -36_830, 'Könyvelő Iroda – 2026. október', { done: 1, link_id: 'a_okt' });
    entry('i_nov', 'plan', 'l_konyv', day(5), -36_830, 'Könyvelő Iroda – 2026. november');
    entry('i_dec', 'plan', 'l_konyv', day(40), -36_830, 'Könyvelő Iroda – 2026. december');
    await storeDigests(t!.env, [navDoc('KI-2026-600', 36_830, day(-3), day(5), 'Könyvelő Iroda Kft.', '33333333')]);
    const r = await t!.post('/api/nav/resolve', { id: 'nav:33333333:KI-2026-600', action: 'recurring', leaf_id: 'l_konyv' });
    expect(r.status).toBe(200);
    expect(nav('nav:33333333:KI-2026-600')).toMatchObject({ status: 'planned', plan_id: 'i_nov' });
    expect(plans().map((p) => p.id)).toEqual(['i_okt', 'i_nov', 'i_dec']);
    expect(series()).toHaveLength(0);
  });

  it('egy másik szállító havi sorozata ugyanabban a sorban nem számít: új sorozat indul', async () => {
    await setup();
    entry('p_szp1', 'plan', 'l_tarhely', day(4), -8_255, 'Szerverpark – 2026. november', { series_id: 's_szp' });
    entry('p_szp2', 'plan', 'l_tarhely', day(34), -8_255, 'Szerverpark – 2026. december', { series_id: 's_szp' });
    t!.sql.exec("INSERT INTO series (id, leaf_id, name, rep, day) VALUES ('s_szp', 'l_tarhely', 'Szerverpark', 'monthly', 5)");
    await storeDigests(t!.env, [navDoc('SZP-2026/0001', 8_255, day(-40), day(-32), 'Szerverpark Zrt.', '11111111')]);
    t!.sql.exec("UPDATE nav_invoices SET status = 'paid'"); // korábbi, már rendezett számla (csak a név ismert)
    await storeDigests(t!.env, [navDoc('WM-2026-000171', 27_630, day(-2), day(6), 'Webműhely Kft.', '22222222')]);
    const r = await t!.post('/api/nav/resolve', { id: 'nav:22222222:WM-2026-000171', action: 'recurring', leaf_id: 'l_tarhely', months: 3 });
    expect(r.status).toBe(200);
    expect(r.data.attached).toBeUndefined();
    expect(series()).toHaveLength(2);
    expect(plans().filter((p) => p.amount === -27_630)).toHaveLength(3);
  });

  it('van havi terve, de a számla idejére nincs szabad terve → egyszeri terv, nem indul második sorozat', async () => {
    await setup();
    entry('p_k1', 'plan', 'l_konyv', day(100), -36_830, 'Könyvelő Iroda – 2027. február', { series_id: 's_k' });
    entry('p_k2', 'plan', 'l_konyv', day(130), -36_830, 'Könyvelő Iroda – 2027. március', { series_id: 's_k' });
    t!.sql.exec("INSERT INTO series (id, leaf_id, name, rep, day) VALUES ('s_k', 'l_konyv', 'Könyvelő Iroda', 'monthly', 10)");
    await storeDigests(t!.env, [navDoc('KI-2026-700', 36_830, day(-3), day(5), 'Könyvelő Iroda Kft.', '33333333')]);
    expect((await t!.post('/api/nav/resolve', { id: 'nav:33333333:KI-2026-700', action: 'recurring', leaf_id: 'l_konyv' })).status).toBe(200);
    expect(series()).toHaveLength(1);
    const own = plans().filter((p) => !['p_k1', 'p_k2'].includes(p.id));
    expect(own).toHaveLength(1);
    expect(own[0]).toMatchObject({ amount: -36_830, series_id: null });
    expect(nav('nav:33333333:KI-2026-700')).toMatchObject({ status: 'planned', plan_id: own[0].id });
  });
});

describe('NAV-terv automatikus rendezése csak ugyanattól a partnertől (settleNavPlans)', () => {
  const plan = (id: string) => t!.sql.prepare('SELECT done, link_id FROM entries WHERE id = ?').get(id) as any;
  /** a könyvelő lejárt NAV-számlája egyszeri tervként (a felületen „Mentés: Könyvelés”) */
  async function konyvPlan() {
    await setup();
    t!.sql.exec("INSERT INTO leaves (id, group_id, label) VALUES ('l_szerviz', 'g_ki', 'Autó szerviz')");
    await storeDigests(t!.env, [navDoc('KI-2026-801', 36_830, day(-15), day(-10), 'Könyvelő Iroda Kft.', '33333333')]);
    expect((await t!.post('/api/nav/resolve', { id: 'nav:33333333:KI-2026-801', action: 'assign', leaf_id: 'l_konyv' })).status).toBe(200);
    return (t!.sql.prepare("SELECT plan_id FROM nav_invoices WHERE id = 'nav:33333333:KI-2026-801'").get() as any).plan_id as string;
  }

  it('egy másik partner azonos összegű ténye nem teljesíti a tervet és nem kerül át a terv kategóriájába; a saját ténye igen', async () => {
    const pid = await konyvPlan();
    entry('i_szerviz', 'actual', 'l_szerviz', day(-8), -36_830, 'Gumiszerviz Bt.', { source: 'import' });
    await settleNavPlans(t!.env);
    await fixLinkedLeaves(t!.env);
    expect(plan(pid)).toMatchObject({ done: 0, link_id: null });
    expect((t!.sql.prepare("SELECT leaf_id FROM entries WHERE id = 'i_szerviz'").get() as any).leaf_id).toBe('l_szerviz');

    entry('i_konyv', 'actual', 'l_konyv', day(-7), -36_830, 'Könyvelési díj', { source: 'import' });
    await settleNavPlans(t!.env);
    expect(plan(pid)).toMatchObject({ done: 1, link_id: 'i_konyv' });
  });

  it('egy másik partner várakozó banki tétele nem hagyódik jóvá a tervre; a szállító (más írásmódú) tétele igen', async () => {
    const pid = await konyvPlan();
    t!.sql.exec(`INSERT INTO bank_accounts (id, provider, bank_name, label) VALUES ('acc1', 'manual', 'Minta Bank', 'Folyószámla');
      INSERT INTO bank_tx (id, account_id, ext_id, date, amount, partner, memo, status, created_at) VALUES
        ('t_mas', 'acc1', 'e1', '${day(-9)}', -36830, 'Valaki Más Bt', 'szamla 2026/77', 'new', 1)`);
    await settleNavPlans(t!.env);
    expect(plan(pid)).toMatchObject({ done: 0, link_id: null });
    expect((t!.sql.prepare("SELECT status FROM bank_tx WHERE id = 't_mas'").get() as any).status).toBe('new');

    t!.sql.exec(`INSERT INTO bank_tx (id, account_id, ext_id, date, amount, partner, memo, status, created_at) VALUES
        ('t_ki', 'acc1', 'e2', '${day(-6)}', -36830, 'KÖNYVELŐ IRODA KFT', 'KI-2026-801', 'ignored', 1)`);
    await settleNavPlans(t!.env);
    expect(plan(pid)).toMatchObject({ done: 1, link_id: 'at_ki' });
    expect((t!.sql.prepare("SELECT status FROM bank_tx WHERE id = 't_mas'").get() as any).status).toBe('new');
  });
});
