// Ütemezett futás (cron → scheduled): mikor ír és mit. Szándék (index.ts, README, aggreg8.ts SYNC_HOURS):
// csak munkanapon, a szinkron-órákban (budapesti idő) fut a teljes szinkron; utána szinkronkérés a Macnek, e-mail az új,
// terv nélküli tételekről, reggel 5-kor a havi terv–tény pillanatkép. A NAV első szinkronja nem vár a szinkron-órára.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createTestApp, type TestApp } from '../helpers/app';
import { installMocks, mockNav, type ExternalMock } from '../helpers/mocks';

let t: TestApp | undefined;
afterEach(() => {
  t?.close();
  t = undefined;
  vi.unstubAllGlobals();
});

const day = (n: number) => new Date(Date.now() + n * 86400_000).toISOString().slice(0, 10);
const row = (sql: string, ...args: any[]) => t!.sql.prepare(sql).get(...args) as any;
const n = (table: string, where = '1=1') => row(`SELECT count(*) AS n FROM ${table} WHERE ${where}`).n as number;
const setting = (k: string) => row('SELECT value FROM settings WHERE key = ?', k)?.value ?? null;

// 2026. november 9. hétfő (munkanap); novemberben a budapesti idő UTC+1
const MON_05 = Date.parse('2026-11-09T04:02:00Z');
const MON_10 = Date.parse('2026-11-09T09:02:00Z');
const MON_13 = Date.parse('2026-11-09T12:02:00Z');
const MON_17 = Date.parse('2026-11-09T16:02:00Z');
const SAT_13 = Date.parse('2026-11-14T12:02:00Z');
const XMAS_13 = Date.parse('2026-12-25T12:02:00Z'); // péntek, munkaszüneti nap

function seed() {
  t!.sql.exec(`
    INSERT INTO groups (id, section, label) VALUES ('g_proj', 'in', 'Projektek'), ('g_ado', 'out', 'Adók');
    INSERT INTO leaves (id, group_id, label) VALUES ('l_minta', 'g_proj', 'Minta'), ('l_afa', 'g_ado', 'ÁFA');
  `);
  // folyó havi bevétel → a szinkron ÁFA-tervet számol belőle
  t!.sql
    .prepare("INSERT INTO entries (id, kind, date, leaf_id, name, amount, done, source, updated_at) VALUES ('a_bev', 'actual', ?, 'l_minta', 'Havi díj', 1270000, 0, 'manual', 1)")
    .run(day(0));
}

function mailbox(): ExternalMock & { sent: any[] } {
  const sent: any[] = [];
  return {
    name: 'brevo',
    env: { BREVO_API_KEY: 'teszt-brevo-kulcs', MAIL_FROM: 'Cashflow <noreply@minta.hu>' },
    sent,
    async handle(req: Request) {
      if (!req.url.startsWith('https://api.brevo.com/')) return null;
      sent.push(await req.json());
      return new Response('{}', { status: 201 });
    },
  };
}

describe('ütemezett futás', () => {
  it('szinkron-órán kívül, hétvégén és ünnepnapon nem ír semmit', async () => {
    t = await createTestApp();
    seed();
    const rev = setting('data_rev');
    for (const at of [MON_10, SAT_13, XMAS_13]) await t.scheduled(at);
    expect(setting('ingest_request')).toBeNull();
    expect(setting('data_rev')).toBe(rev);
    expect(n('entries', "source = 'vat'")).toBe(0);
    expect(n('month_stats')).toBe(0);
  });

  it('munkanapi szinkron-órán: teljes szinkron (pl. ÁFA-terv), szinkronkérés a Macnek, új adat-verzió; ismételt futás nem duplikál', async () => {
    t = await createTestApp();
    seed();
    const rev = setting('data_rev');
    await t.scheduled(MON_13);
    expect(JSON.parse(setting('ingest_request'))).toMatchObject({ by: 'ütemezett' });
    expect(setting('data_rev')).not.toBe(rev);
    const vat = t.sql.prepare("SELECT id, leaf_id, amount, done FROM entries WHERE source = 'vat'").all() as any[];
    expect(vat.length).toBeGreaterThan(0);
    expect(vat.every((e) => e.leaf_id === 'l_afa' && e.amount < 0 && e.done === 0)).toBe(true);
    // 13 órakor nincs pillanatkép (az csak reggel 5-kor készül)
    expect(n('month_stats')).toBe(0);
    await t.scheduled(MON_17);
    expect(t.sql.prepare("SELECT id, leaf_id, amount, done FROM entries WHERE source = 'vat'").all()).toEqual(vat);
  });

  it('reggel 5-kor a havi terv–tény pillanatkép is elkészül (a folyó hónap tervvel és ténnyel)', async () => {
    t = await createTestApp();
    seed();
    // a pillanatkép a tervezés kezdetétől készül: a folyó hónapban is van terv
    t.sql
      .prepare("INSERT INTO entries (id, kind, date, leaf_id, name, amount, done, source, updated_at) VALUES ('p_bev', 'plan', ?, 'l_minta', 'Havi díj', 1270000, 0, 'manual', 1)")
      .run(day(0));
    await t.scheduled(MON_13);
    expect(n('month_stats')).toBe(0);
    await t.scheduled(MON_05);
    const cur = row('SELECT plan_in, act_in, closed FROM month_stats WHERE ym = ?', day(0).slice(0, 7));
    expect(cur).toEqual({ plan_in: 1_270_000, act_in: 1_270_000, closed: 0 });
  });

  it('NAV: az első szinkron órán kívül is lefut; utána csak szinkron-órán; az új, terv nélküli számláról e-mail megy (az elsőről nem)', async () => {
    const nav = mockNav();
    const mail = mailbox();
    const ext = installMocks(nav, mail);
    t = await createTestApp({ env: ext.env as any });
    seed();
    nav.addInvoice({ number: 'TSZ-2026/0815', supplierName: 'Tárhely Szolgáltató Kft.', supplierTax: '12345678-2-41', issueDate: day(-6), paymentDate: day(2), gross: 12_700 });
    await t.scheduled(MON_10);
    expect(n('nav_invoices')).toBe(1);
    expect(setting('nav_last_sync')).not.toBeNull();
    expect(setting('ingest_request')).toBeNull(); // órán kívül nincs teljes szinkron

    // második számla órán kívül: már nem jön be (nem első szinkron)
    nav.addInvoice({ number: 'KI-2026-515', supplierName: 'Könyvelő Iroda Kft.', supplierTax: '87654321-2-13', issueDate: day(-1), paymentDate: day(7), gross: 36_830 });
    await t.scheduled(MON_10 + 3600_000);
    expect(n('nav_invoices')).toBe(1);

    // szinkron-óra: bejön; az értesítés első futása csak megjegyzi az időpontot (nem küldi el az előzményt)
    await t.scheduled(MON_13);
    expect(n('nav_invoices')).toBe(2);
    expect(mail.sent).toHaveLength(0);
    // újabb számla → a következő szinkron-órán e-mail az adminnak, csak az új tétellel
    nav.addInvoice({ number: 'SZ-77', supplierName: 'Minta Szoftver Kft.', supplierTax: '11223344-2-42', issueDate: day(0), paymentDate: day(8), gross: 49_900 });
    await t.scheduled(MON_17);
    expect(n('nav_invoices')).toBe(3);
    expect(mail.sent).toHaveLength(1);
    expect(mail.sent[0].to).toEqual([{ email: 'admin@teszt.hu' }]);
    expect(mail.sent[0].textContent).toContain('Minta Szoftver Kft.');
    expect(mail.sent[0].textContent).not.toContain('Könyvelő Iroda');
  });
});
