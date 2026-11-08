// Banki tétel ↔ terv / Billingo-tény párosítás és jóváhagyás: jóváhagyás után a terv lezárul és tény lesz belőle;
// a visszavonás pontosan visszaállítja az előző állapotot (nem marad lezárt terv törölt ténnyel, nem vész el bevétel).
import { afterEach, describe, expect, it } from 'vitest';
import { createTestApp, type TestApp } from '../helpers/app';
import { L, addEntry, day, entry, importRows, seedTree, txBy } from '../helpers/bank-fixtures';
import { markBankFees } from '../../src/server/app/bank';

let t: TestApp | undefined;
afterEach(() => t?.close());

async function setup() {
  t = await createTestApp();
  seedTree(t);
  return t;
}

describe('jóváhagyás tervvel', () => {
  it('a kiválasztott terv lezárul, a tény a banki napra kerül és a tervhez kötődik; visszavonva a terv újra nyitott', async () => {
    const t = await setup();
    addEntry(t, { id: 'p_konyv', kind: 'plan', date: day(-5), leaf_id: L.konyv, amount: -36000, name: 'Könyvelési díj' });
    await importRows(t, [{ date: day(-3), amount: -36000, partner: 'Minta Könyvelő Kft.', memo: 'MK-2026-55' }]);
    const tx = txBy(t, 'amount = -36000');
    const r = await t.post('/api/bank/approve', { items: [{ id: tx.id, leaf_id: L.konyv, plan_id: 'p_konyv' }] });
    expect(r.status).toBe(200);
    const a = entry(t, 'a' + tx.id);
    expect(a).toMatchObject({ kind: 'actual', date: day(-3), amount: -36000, leaf_id: L.konyv, source: 'bank' });
    expect(entry(t, 'p_konyv')).toMatchObject({ done: 1, link_id: a.id });
    expect(txBy(t, `id = '${tx.id}'`)).toMatchObject({ status: 'approved', actual_id: a.id, plan_id: 'p_konyv' });
    // a partner megtanult kategóriája (a következő tétel már ide kerül)
    expect((t.sql.prepare("SELECT leaf_id FROM partner_rules WHERE pattern = 'minta konyvelo'").get() as any)?.leaf_id).toBe(L.konyv);

    await t.post('/api/bank/unapprove', { ids: [tx.id] });
    expect(entry(t, a.id)).toBeUndefined();
    expect(entry(t, 'p_konyv')).toMatchObject({ done: 0, link_id: null });
    expect(txBy(t, `id = '${tx.id}'`).status).toBe('new');
  });

  it('már teljesült tervet nem köt át (különben a korábbi tény terv nélkül maradna – dupla költség)', async () => {
    const t = await setup();
    addEntry(t, { id: 'a_old', kind: 'actual', date: day(-6), leaf_id: L.konyv, amount: -36000, source: 'import' });
    addEntry(t, { id: 'p_done', kind: 'plan', date: day(-5), leaf_id: L.konyv, amount: -36000, done: 1, link_id: 'a_old' });
    await importRows(t, [{ date: day(-3), amount: -36000, partner: 'Minta Könyvelő Kft.', memo: '' }]);
    const tx = txBy(t, 'amount = -36000');
    const r = await t.post('/api/bank/approve', { items: [{ id: tx.id, leaf_id: L.konyv, plan_id: 'p_done' }] });
    expect(r.status).toBe(409);
    expect(entry(t, 'p_done').link_id).toBe('a_old');
    expect(txBy(t, `id = '${tx.id}'`).status).toBe('new');
    expect(entry(t, 'a' + tx.id)).toBeUndefined();
  });

  it('egy kérésben két tétel nem zárhatja le ugyanazt a tervet', async () => {
    const t = await setup();
    addEntry(t, { id: 'p1', kind: 'plan', date: day(-5), leaf_id: L.dom, amount: -4990, name: 'Tárhely' });
    await importRows(t, [
      { date: day(-4), amount: -4990, partner: 'Minta Tárhely Kft.', memo: 'A' },
      { date: day(-3), amount: -4990, partner: 'Minta Tárhely Kft.', memo: 'B' },
    ]);
    const [x, y] = t.sql.prepare('SELECT id FROM bank_tx ORDER BY date').all() as any[];
    const r = await t.post('/api/bank/approve', {
      items: [
        { id: x.id, leaf_id: L.dom, plan_id: 'p1' },
        { id: y.id, leaf_id: L.dom, plan_id: 'p1' },
      ],
    });
    expect(r.status).toBe(409);
    expect(entry(t, 'p1').done).toBe(0);
  });

  it('a „kész” tételek tömeges jóváhagyásánál a javasolt terv csak hasonló összegnél zárul le (kis díj nem zár le havidíjat)', async () => {
    const t = await setup();
    addEntry(t, { id: 'p_konyv', kind: 'plan', date: day(-5), leaf_id: L.konyv, amount: -36000, name: 'Könyvelési díj' });
    await importRows(t, [{ date: day(-3), amount: -92, partner: 'Minta Könyvelő Kft.', memo: '' }]);
    const tx = txBy(t, 'amount = -92');
    // korábbi (hibás) javaslat a tételen
    t.sql.prepare('UPDATE bank_tx SET leaf_id = ?, plan_id = ? WHERE id = ?').run(L.konyv, 'p_konyv', tx.id);
    await t.post('/api/bank/approve', { ids: [tx.id] });
    expect(entry(t, 'p_konyv').done).toBe(0);
    expect(entry(t, 'a' + tx.id)).toMatchObject({ amount: -92, link_id: null });
  });

  it('terv nélkül jóváhagyott tény a hónap azonos összegű tervéhez kötődik; visszavonáskor ez a terv is újra nyitott', async () => {
    const t = await setup();
    await importRows(t, [{ date: day(-3), amount: -36000, partner: 'Minta Könyvelő Kft.', memo: '' }]);
    const tx = txBy(t, 'amount = -36000');
    // a terv a banki tétel beérkezése után jött létre (nincs rajta javaslat)
    addEntry(t, { id: 'p_late', kind: 'plan', date: day(-4), leaf_id: L.konyv, amount: -36000, name: 'Könyvelési díj' });
    await t.post('/api/bank/approve', { items: [{ id: tx.id, leaf_id: L.konyv, plan_id: null }] });
    expect(entry(t, 'p_late')).toMatchObject({ done: 1, link_id: 'a' + tx.id });
    await t.post('/api/bank/unapprove', { ids: [tx.id] });
    expect(entry(t, 'a' + tx.id)).toBeUndefined();
    expect(entry(t, 'p_late')).toMatchObject({ done: 0, link_id: null });
  });

  it('ismétlődő jóváhagyás: a következő hónapok tervei létrejönnek, visszavonáskor törlődnek', async () => {
    const t = await setup();
    await importRows(t, [{ date: day(-3), amount: -4990, partner: 'Minta Tárhely Kft.', memo: '' }]);
    const tx = txBy(t, 'amount = -4990');
    await t.post('/api/bank/approve', { items: [{ id: tx.id, leaf_id: L.dom, plan_id: null, rep: 'monthly', count: 3 }] });
    const plans = t.sql.prepare("SELECT amount, done FROM entries WHERE kind = 'plan' AND series_id = ?").all('s' + tx.id) as any[];
    expect(plans).toHaveLength(3);
    expect(plans.every((p) => p.amount === -4990 && p.done === 0)).toBe(true);
    await t.post('/api/bank/unapprove', { ids: [tx.id] });
    expect(t.sql.prepare("SELECT COUNT(*) AS n FROM entries WHERE series_id = ?").get('s' + tx.id)).toEqual({ n: 0 });
  });
});

describe('bevétel és a Billingo „fizetve” tény', () => {
  function billingoPaid(t: TestApp, leaf: string, amount: number, docId: number, planId: string) {
    addEntry(t, { id: 'bp' + docId, kind: 'actual', date: day(-4), leaf_id: leaf, amount, source: 'billingo', ext_ref: 'bpaid:' + docId });
    addEntry(t, { id: planId, kind: 'plan', date: day(-6), leaf_id: leaf, amount, done: 1, link_id: 'bp' + docId, source: 'billingo', ext_ref: 'billingo:' + docId });
  }

  it('a partner befizetése a saját Billingo-tényéhez kötődik (nincs dupla bevétel); visszavonva a Billingo-tény megmarad', async () => {
    const t = await setup();
    billingoPaid(t, L.alfa, 254000, 5001, 'p_alfa');
    await importRows(t, [{ date: day(-2), amount: 254000, partner: 'Alfa Kft.', memo: '2026-000045' }]);
    const tx = txBy(t, 'amount = 254000');
    await t.post('/api/bank/approve', { items: [{ id: tx.id, leaf_id: L.alfa, plan_id: null }] });
    expect(txBy(t, `id = '${tx.id}'`)).toMatchObject({ status: 'approved', actual_id: 'bp5001' });
    expect(t.sql.prepare("SELECT COUNT(*) AS n FROM entries WHERE kind = 'actual' AND amount = 254000").get()).toEqual({ n: 1 });

    await t.post('/api/bank/unapprove', { ids: [tx.id] });
    // a Billingo szerint kifizetett számla bevétele nem tűnhet el, a terve lezárva marad
    expect(entry(t, 'bp5001')).toMatchObject({ amount: 254000, source: 'billingo', ext_ref: 'bpaid:5001' });
    expect(entry(t, 'p_alfa')).toMatchObject({ done: 1, link_id: 'bp5001' });
    expect(txBy(t, `id = '${tx.id}'`)).toMatchObject({ status: 'new', actual_id: null });
  });

  it('egy másik ügyfél azonos összegű Billingo-tényét nem „lopja el”', async () => {
    const t = await setup();
    billingoPaid(t, L.beta, 120000, 5002, 'p_beta');
    await importRows(t, [{ date: day(-2), amount: 120000, partner: 'Alfa Kft.', memo: '2026-000046' }]);
    const tx = txBy(t, 'amount = 120000');
    await t.post('/api/bank/approve', { items: [{ id: tx.id, leaf_id: L.alfa, plan_id: null }] });
    // Alfa befizetése Alfa ténye lesz; Béta Billingo-ténye érintetlen (a későbbi Béta-utalás ahhoz kötődik)
    expect(entry(t, 'a' + tx.id)).toMatchObject({ leaf_id: L.alfa, amount: 120000 });
    expect(entry(t, 'bp5002')).toMatchObject({ leaf_id: L.beta, ext_ref: 'bpaid:5002', source: 'billingo' });
  });
});

describe('banki díjak', () => {
  it('a tévesen a partner tervére jóváhagyott díj a Bank költségbe kerül, a terv újra nyitott, a tény nem mutat a tervre', async () => {
    const t = await setup();
    addEntry(t, { id: 'p_konyv', kind: 'plan', date: day(-5), leaf_id: L.konyv, amount: -36000, name: 'Könyvelési díj' });
    // a fő utalás és mellette a díj ugyanannak a partnernek, üres közleménnyel
    await importRows(t, [
      { date: day(-3), amount: -36000, partner: 'Minta Könyvelő Kft.', memo: 'MK-2026-60' },
      { date: day(-3), amount: -92, partner: 'Minta Könyvelő Kft.', memo: '' },
    ]);
    const fee = txBy(t, 'amount = -92');
    await t.post('/api/bank/approve', { items: [{ id: fee.id, leaf_id: L.konyv, plan_id: 'p_konyv' }] });
    expect(entry(t, 'p_konyv').done).toBe(1);
    await markBankFees(t.env);
    expect(entry(t, 'a' + fee.id)).toMatchObject({ leaf_id: L.bank, link_id: null });
    expect(entry(t, 'p_konyv')).toMatchObject({ done: 0, link_id: null });
  });

  it('az automatikus „Banki díjak” szabály havonta és bankonként egy tényben vonja össze a díjakat, és lezárja a havi tervet', async () => {
    const t = await setup();
    const ym = day(0).slice(0, 7);
    addEntry(t, { id: 'p_bank', kind: 'plan', date: ym + '-01', leaf_id: L.bank, amount: -5000, name: 'Bankköltség' });
    await importRows(t, [
      { date: ym + '-01', amount: -199, partner: 'Tranzakciós díj', memo: 'utalás A' },
      { date: ym + '-01', amount: -350, partner: 'Számlavezetési díj', memo: '' },
    ]);
    const merged = t.sql.prepare("SELECT * FROM entries WHERE id LIKE 'm\\_%' ESCAPE '\\'").all() as any[];
    expect(merged).toHaveLength(1);
    expect(merged[0]).toMatchObject({ amount: -549, leaf_id: L.bank, link_id: 'p_bank' });
    expect(entry(t, 'p_bank')).toMatchObject({ done: 1, link_id: merged[0].id });
    // egy díj visszavonása csak a saját összegét veszi ki
    const one = txBy(t, 'amount = -199');
    await t.post('/api/bank/unapprove', { ids: [one.id] });
    expect(entry(t, merged[0].id).amount).toBe(-350);
  });
});

describe('„Havonta” jóváhagyás, ha a partnernek már van havi terve', () => {
  const plansOf = (t: TestApp) => t.sql.prepare("SELECT id, done, link_id, series_id FROM entries WHERE kind = 'plan' ORDER BY date").all() as any[];
  const seriesN = (t: TestApp) => (t.sql.prepare('SELECT COUNT(*) AS n FROM series').get() as any).n;

  it('importált havi tervek mellett nem indul második sorozat; a tény a hónap tervét zárja le, visszavonva újra nyitott', async () => {
    const t = await setup();
    addEntry(t, { id: 'i_m0', kind: 'plan', date: day(-3), leaf_id: L.dom, amount: -4990, name: 'Minta Tárhely – e havi', source: 'import' });
    addEntry(t, { id: 'i_m1', kind: 'plan', date: day(27), leaf_id: L.dom, amount: -4990, name: 'Minta Tárhely – következő', source: 'import' });
    addEntry(t, { id: 'i_m2', kind: 'plan', date: day(57), leaf_id: L.dom, amount: -4990, name: 'Minta Tárhely – azutáni', source: 'import' });
    await importRows(t, [{ date: day(-3), amount: -4990, partner: 'Minta Tárhely Kft.', memo: '' }]);
    const tx = txBy(t, 'amount = -4990');
    // a felület a „nincs terv” választást plan_id: null-lal küldi
    expect((await t.post('/api/bank/approve', { items: [{ id: tx.id, leaf_id: L.dom, plan_id: null, rep: 'monthly', count: 12 }] })).status).toBe(200);
    expect(plansOf(t).map((p) => p.id)).toEqual(['i_m0', 'i_m1', 'i_m2']);
    expect(seriesN(t)).toBe(0);
    expect(entry(t, 'i_m0')).toMatchObject({ done: 1, link_id: 'a' + tx.id });
    expect(entry(t, 'i_m1').done).toBe(0);
    await t.post('/api/bank/unapprove', { ids: [tx.id] });
    expect(plansOf(t)).toHaveLength(3);
    expect(entry(t, 'i_m0')).toMatchObject({ done: 0, link_id: null });
  });

  it('a partner korábbi „Havonta” jóváhagyásának sorozata mellé nem jön második; a tény a meglévő sorozathoz kötődik', async () => {
    const t = await setup();
    await importRows(t, [
      { date: day(-33), amount: -4990, partner: 'Minta Tárhely Kft.', memo: 'előző havi díj' },
      { date: day(-3), amount: -4990, partner: 'MINTA TÁRHELY KFT', memo: 'havi díj' },
    ]);
    const first = txBy(t, `memo = 'előző havi díj'`);
    const second = txBy(t, `memo = 'havi díj'`);
    await t.post('/api/bank/approve', { items: [{ id: first.id, leaf_id: L.dom, plan_id: null, rep: 'monthly', count: 3 }] });
    expect(plansOf(t)).toHaveLength(3);
    await t.post('/api/bank/approve', { items: [{ id: second.id, leaf_id: L.dom, plan_id: null, rep: 'monthly', count: 12 }] });
    expect(seriesN(t)).toBe(1);
    expect(plansOf(t).filter((p) => p.series_id === 's' + first.id)).toHaveLength(3);
    expect(t.sql.prepare('SELECT COUNT(*) AS n FROM entries WHERE series_id = ?').get('s' + second.id)).toEqual({ n: 0 });
    expect(entry(t, 'a' + second.id)).toMatchObject({ kind: 'actual', series_id: 's' + first.id });
  });

  it('egy másik szolgáltató havi terve ugyanabban a kategóriában nem akadályozza az új sorozatot', async () => {
    const t = await setup();
    addEntry(t, { id: 'i_mas1', kind: 'plan', date: day(10), leaf_id: L.dom, amount: -8255, name: 'Más Tárhely – következő', source: 'import' });
    addEntry(t, { id: 'i_mas2', kind: 'plan', date: day(40), leaf_id: L.dom, amount: -8255, name: 'Más Tárhely – azutáni', source: 'import' });
    t.sql.exec("INSERT INTO partners (key, name, aliases, updated_at) VALUES ('mastarhely', 'Más Tárhely Kft.', '[]', 1)");
    await importRows(t, [{ date: day(-3), amount: -4990, partner: 'Minta Tárhely Kft.', memo: '' }]);
    const tx = txBy(t, 'amount = -4990');
    await t.post('/api/bank/approve', { items: [{ id: tx.id, leaf_id: L.dom, plan_id: null, rep: 'monthly', count: 3 }] });
    expect(t.sql.prepare("SELECT COUNT(*) AS n FROM entries WHERE kind = 'plan' AND series_id = ?").get('s' + tx.id)).toEqual({ n: 3 });
    expect(entry(t, 'i_mas1').done).toBe(0);
  });
});
