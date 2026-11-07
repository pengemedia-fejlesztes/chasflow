// Partnertörzs és partnerstatisztika végponttól végpontig: valódi backend (memóriabeli SQLite), a /api/data csomagon
// számolt partnerstatisztikával – úgy, ahogy a Partnertörzs / partner adatlap látja.
import { afterEach, describe, expect, it } from 'vitest';
import { partnerResolver } from '../../src/shared/identity';
import { partnerStats } from '../../src/shared/partners';
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

  it.todo(
    'KÉRDÉS: a partner adatlapon a „Nettó” levonja-e a más (nem azonos nevű) kiadási sorban lévő, a partner nevét viselő tételeket ' +
      '(pl. „Tibeko havi díj” az IT szolgáltatás alatt, miközben a Tibeko ügyfél is)? Most csak az azonos nevű sorok számítanak.',
  );
});
