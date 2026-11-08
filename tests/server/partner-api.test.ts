// Partnertörzs és partnerstatisztika végponttól végpontig: valódi backend (memóriabeli SQLite), a /api/data csomagon
// számolt partnerstatisztikával – úgy, ahogy a Partnertörzs / partner adatlap látja.
import { afterEach, describe, expect, it } from 'vitest';
import { partnerResolver } from '../../src/shared/identity';
import { partnerStats } from '../../src/shared/partners';
import { breakeven, partnerSubcontracts } from '../../src/shared/worktime';
import type { DataBundle } from '../../src/shared/types';
import { createTestApp, type TestApp } from '../helpers/app';

let t: TestApp | undefined;
afterEach(() => t?.close());

const T0 = Date.parse('2026-10-01T08:00:00Z');

function seed(app: TestApp) {
  const q = (s: string, ...a: unknown[]) => app.sql.prepare(s).run(...(a as any[]));
  q("INSERT INTO groups (id, section, label, sort) VALUES ('g_proj', 'in', 'Projektek', 1)");
  q("INSERT INTO groups (id, section, label, sort) VALUES ('g_ajanl', 'in', 'Ajánlatok', 0)");
  q("INSERT INTO groups (id, section, label, sort) VALUES ('g_alv', 'out', '2 Alvállalkozók', 2)");
  q("INSERT INTO groups (id, section, label, sort) VALUES ('g_mk', 'out', '3 Működési költségek', 3)");
  q("INSERT INTO leaves (id, group_id, label, sort) VALUES ('l_minta', 'g_proj', 'Minta', 1)");
  q("INSERT INTO leaves (id, group_id, label, sort) VALUES ('l_webshop', 'g_ajanl', 'Minta Webshop', 2)");
  q("INSERT INTO leaves (id, group_id, label, sort) VALUES ('l_kovacs', 'g_alv', 'Kovács Bence', 1)");
  q("INSERT INTO leaves (id, group_id, label, sort) VALUES ('l_it', 'g_mk', 'IT szolgáltatás', 1)");
  const e = (id: string, leaf: string, date: string, amount: number, name: string) =>
    q(
      "INSERT INTO entries (id, kind, date, leaf_id, name, amount, done, tentative, source, updated_at) VALUES (?, 'actual', ?, ?, ?, ?, 0, 0, 'manual', ?)",
      id,
      date,
      leaf,
      name,
      amount,
      T0,
    );
  e('a1', 'l_minta', '2026-08-12', 1_270_000, 'Webfejlesztés');
  e('a2', 'l_webshop', '2026-09-15', 635_000, 'Havi díj');
  e('k1', 'l_kovacs', '2026-08-20', -450_000, 'Minta webfejlesztés');
  e('it1', 'l_it', '2026-09-05', -25_400, 'Szerver bérlés');
}

const bundle = async (app: TestApp) => (await app.get<DataBundle>('/api/data')).data;
const stats = (d: DataBundle) => partnerStats(d.entries, d.leaves, d.groups, d.billingo, '2026-10-20', d.partnerNames || [], d.partners || [], true);

describe('partnertörzs: átnevezés meglévő partner nevére (összevonás)', () => {
  it('a cél partner adószáma és alternatív nevei megmaradnak, a forrás nevei hozzájuk adódnak', async () => {
    t = await createTestApp();
    seed(t);
    // mindkét partnernek van törzsadata: a „Minta” adószámmal és a számlázási cégnévvel, a „Minta Webshop” egy banki névvel
    expect((await t.put('/api/partners/minta', { tax_number: '12345678-2-13', aliases: ['Minta Kereskedelmi Kft.'] })).status).toBe(200);
    expect((await t.put('/api/partners/mintawebshop', { aliases: ['MINTA WEBSHOP BANKKARTYA'] })).status).toBe(200);
    // a „Minta Webshop” sort (másik mappában) átnevezik „Minta”-ra → egy partner lesz
    const r = await t.put('/api/partners/mintawebshop', { name: 'Minta' });
    expect(r.status).toBe(200);
    expect(r.data.key).toBe('minta');
    const rows = t.sql.prepare('SELECT key, tax_number, aliases FROM partners ORDER BY key').all() as any[];
    expect(rows.map((x) => x.key)).toEqual(['minta']);
    // az adószám nem veszhet el (ez azonosítja a NAV/Billingo számlákat)
    expect(rows[0].tax_number).toBe('12345678-2-13');
    expect(JSON.parse(rows[0].aliases)).toEqual(expect.arrayContaining(['Minta Kereskedelmi Kft.', 'MINTA WEBSHOP BANKKARTYA']));
    // a csomagban egy partnerként, a két sor bevételével látszik
    const st = stats(await bundle(t)).find((x) => x.key === 'minta')!;
    expect(st.sides.in?.total).toBe(1_905_000);
    expect(st.leaves.map((l) => l.id).sort()).toEqual(['l_minta', 'l_webshop']);
  });

  it('az összevonás után az adószám alapján a resolver a cél partnert adja', async () => {
    t = await createTestApp();
    seed(t);
    await t.put('/api/partners/minta', { tax_number: '12345678-2-13' });
    await t.put('/api/partners/mintawebshop', { name: 'Minta' });
    const d = await bundle(t);
    const r = partnerResolver(d.leaves, d.partners || []);
    expect(r.resolve('Teljesen Más Név Zrt.', '12345678-2-13')?.key).toBe('minta');
  });
});

describe('partner jövedelmezősége: a kiadás csak azonos nevű alkategóriából kerül a partnerhez', () => {
  it('az ügyfél kiadás nélkül látszik, ha a költsége az alvállalkozó nevén fut (a tétel nevében az ügyfél neve)', async () => {
    t = await createTestApp();
    seed(t);
    const d = await bundle(t);
    const minta = stats(d).find((x) => x.key === 'minta')!;
    expect(minta.sides.in?.total).toBe(1_270_000);
    // a „Minta webfejlesztés” alvállalkozói díj nem a partnernél, hanem az alvállalkozónál van – így a partner
    // kiadás nélkül, „tiszta bevételként” látszik. A Fedezeti pont projekt-sorában ez már levonódik (lásd partner-breakeven).
    expect(minta.sides.out).toBeUndefined();
    expect(stats(d).find((x) => x.key === 'kovacsbence')!.sides.out?.total).toBe(450_000);
  });

  it('kiadási sor összekötése az ügyféllel (bevétel ↔ kiadás összevonás) után a partnernél bevétel és kiadás is látszik', async () => {
    t = await createTestApp();
    seed(t);
    t.sql.prepare("INSERT INTO leaves (id, group_id, label, sort) VALUES ('l_minta_out', 'g_mk', 'Minta tárhely', 5)").run();
    t.sql
      .prepare(
        "INSERT INTO entries (id, kind, date, leaf_id, name, amount, done, tentative, source, updated_at) VALUES ('o1', 'actual', '2026-09-20', 'l_minta_out', 'Tárhely', -60000, 0, 0, 'manual', ?)",
      )
      .run(T0);
    const r = await t.post('/api/leaves/l_minta_out/merge', { into: 'l_minta' });
    expect(r.data).toMatchObject({ ok: true, linked: true });
    const d = await bundle(t);
    const minta = stats(d).find((x) => x.key === 'minta')!;
    expect(minta.sides.in?.total).toBe(1_270_000);
    expect(minta.sides.out?.total).toBe(60_000);
    expect(minta.byYear['2026']).toEqual({ inc: 1_270_000, out: 60_000 });
  });

  it('az ügyfélnevet viselő alvállalkozói díj a partnernél külön sorban látszik („Kiadás · 12 hó (alvállalkozó)”), a Nettó nem változik', async () => {
    t = await createTestApp();
    seed(t);
    const q = (s: string, ...a: unknown[]) => t!.sql.prepare(s).run(...(a as any[]));
    q("INSERT INTO leaves (id, group_id, label, sort) VALUES ('l_nagy', 'g_alv', 'Nagy Anna', 2)");
    q("INSERT INTO employees (key, name, cost_leaf_id, updated_at) VALUES ('nagyanna', 'Nagy Anna', 'l_nagy', ?)", T0);
    const e = (id: string, kind: string, leaf: string, date: string, amount: number, name: string, link: string | null = null, done = 0) =>
      q(
        "INSERT INTO entries (id, kind, date, leaf_id, name, amount, done, tentative, source, link_id, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, 0, 'manual', ?, ?)",
        id,
        kind,
        date,
        leaf,
        name,
        amount,
        done,
        link,
        T0,
      );
    // a banki tény neve a kedvezményezett, az ügyfelet a hozzá kötött terv nevezi meg
    e('k2', 'actual', 'l_kovacs', '2026-10-05', -120_000, 'KOVACS BENCE EV');
    e('kp2', 'plan', 'l_kovacs', '2026-10-05', -120_000, 'Minta – karbantartás', 'k2', 1);
    // 12 hónapnál régebbi díj: csak az összesbe számít
    e('k3', 'actual', 'l_kovacs', '2025-05-10', -80_000, 'Minta grafika');
    // nyitott terv az ügyfél nevével: várható alvállalkozói díj
    e('kp4', 'plan', 'l_kovacs', '2026-11-10', -100_000, 'Minta – november');
    // nem alvállalkozó (működési költség) és munkaidő-táblás munkatárs (az a munkaköltségben van): nem számít ide
    e('it2', 'actual', 'l_it', '2026-09-08', -30_000, 'Minta szerver');
    e('n1', 'actual', 'l_nagy', '2026-09-30', -50_000, 'Minta támogatás');
    // más ügyfél nevével / ügyfélnév nélkül: nem a Minta partneré
    e('k5', 'actual', 'l_kovacs', '2026-09-25', -40_000, 'Megbízási díj');

    const d = await bundle(t);
    const sub = partnerSubcontracts({
      entries: d.entries,
      leaves: d.leaves,
      groups: d.groups,
      employees: d.employees || [],
      partners: d.partners || [],
      today: '2026-10-20',
    });
    expect(sub.get('minta')).toMatchObject({ last12: 570_000, total: 650_000, count: 3, planned: 100_000 });
    expect(
      sub
        .get('minta')!
        .items.map((x) => x.id)
        .sort(),
    ).toEqual(['k1', 'k2', 'k3']);
    expect(sub.has('kovacsbence')).toBe(false);

    // csak megjelenítés: a partner kiadása és nettója változatlan (a díj az alvállalkozónál marad)
    const minta = stats(d).find((x) => x.key === 'minta')!;
    expect(minta.sides.in?.total).toBe(1_270_000);
    expect(minta.sides.out).toBeUndefined();
    expect(stats(d).find((x) => x.key === 'kovacsbence')!.sides.out?.total).toBe(450_000 + 120_000 + 80_000 + 40_000);

    // a Fedezeti pont projekt-sora ugyanezt a díjat vonja le (ugyanaz a hozzárendelés)
    const aliases = new Map<string, string[]>();
    const be = breakeven({
      months: ['2026-08', '2026-10'],
      entries: d.entries,
      leaves: d.leaves,
      groups: d.groups,
      employees: d.employees || [],
      worktime: [],
      aliases,
    });
    expect(be.map((m) => m.projects.find((p) => p.leaf === 'l_minta')?.subcontract)).toEqual([450_000, 120_000]);
  });
});
