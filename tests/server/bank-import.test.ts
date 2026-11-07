// Banki tételek beérkezése: kézi kivonat-import, a Mac-ügynök aggreg8 feltöltése, Enable Banking (PSD2) szinkron –
// duplikáció-szűrés, a TÉNYEK importjával átfedő időszak archiválása, egyenleg.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createTestApp, type TestApp } from '../helpers/app';
import { L, addEntry, day, importRows, seedTree, txs } from '../helpers/bank-fixtures';
import { syncBanks } from '../../src/server/app/bank';

let t: TestApp | undefined;
afterEach(() => {
  t?.close();
  vi.unstubAllGlobals();
});

// kitalált, MagNet-bankkódú (162) számlaszám – a Mac-ügynök ebből ismeri fel a bankot
const ACC = 'HU00 1620 0000 0000 0000 0000 0000';

async function ingest(app: TestApp, body: unknown) {
  const tok = await app.post('/api/ingest/token');
  return app.call('POST', '/api/ingest/aggreg8', JSON.stringify(body), {
    Authorization: 'Bearer ' + tok.data.token,
    'Content-Type': 'application/json',
  });
}

describe('kézi kivonat-import', () => {
  it('a tételek jóváhagyásra várnak, ugyanannak a kivonatnak az újrafeltöltése nem duplikál', async () => {
    t = await createTestApp();
    seedTree(t);
    const rows = [
      { date: day(-3), amount: -36830, partner: 'Minta Könyvelő Kft.', memo: 'MK-2026-101', ext: '9001' },
      { date: day(-3), amount: -199, partner: 'Tranzakciós díj', memo: 'MK-2026-101', ext: '9001|-199' },
      { date: day(-2), amount: 250000, partner: 'Alfa Kft.', memo: 'Számla 2026-000031' },
    ];
    const r1 = await importRows(t, rows);
    expect(r1.rows).toBe(3);
    // a banki díj a beépített automatikus szabállyal azonnal tény (Bank költség, havi összevonás), a többi jóváhagyásra vár
    expect(txs(t).map((x) => [x.amount, x.status])).toEqual([
      [-36830, 'new'],
      [-199, 'approved'],
      [250000, 'new'],
    ]);
    const r2 = await importRows(t, rows);
    expect(r2.duplicates).toBe(3);
    expect(txs(t)).toHaveLength(3);
  });

  it('ugyanazon a napon két azonos összegű, de különböző tétel (pl. két 199 Ft-os díj) mindkettő megmarad', async () => {
    t = await createTestApp();
    seedTree(t);
    await importRows(t, [
      { date: day(-3), amount: -199, partner: 'Tranzakciós díj', memo: 'utalás A' },
      { date: day(-3), amount: -199, partner: 'Tranzakciós díj', memo: 'utalás B' },
    ]);
    expect(txs(t)).toHaveLength(2);
  });

  it('a TÉNYEK importja előtti időszak archívumba kerül, a már rögzített tény párja is; a rögzítetlen friss tétel jóváhagyásra vár', async () => {
    t = await createTestApp();
    seedTree(t);
    // az xls-import utolsó ténye 10 napja volt
    addEntry(t, { id: 'i1', kind: 'actual', date: day(-10), leaf_id: L.konyv, amount: -36830, source: 'import', name: 'Könyvelési díj' });
    await importRows(t, [
      { date: day(-80), amount: -12000, partner: 'Régi Bolt Kft.', memo: '' }, // a 45 napos ablak előtt
      { date: day(-12), amount: -36830, partner: 'Minta Könyvelő Kft.', memo: '' }, // a tény párja (±7 nap)
      { date: day(-20), amount: 75000, partner: 'Béta Bt.', memo: '' }, // nincs tény → jóváhagyásra
      { date: day(-5), amount: -4990, partner: 'Minta Tárhely Kft.', memo: '' }, // a cutoff után
    ]);
    const st = Object.fromEntries(txs(t).map((x) => [x.amount, x.status]));
    expect(st).toEqual({ '-12000': 'ignored', '-36830': 'ignored', '75000': 'new', '-4990': 'new' });
  });
});

describe('Mac-ügynök (aggreg8 JSON) feltöltése', () => {
  it('a kivonat-fájlból már meglévő tétel más azonosítóval sem duplikálódik', async () => {
    t = await createTestApp();
    seedTree(t);
    // előbb kézzel feltöltött MagNet kivonat (a bank saját kódjával)
    await importRows(t, [{ date: day(-4), amount: -8490, partner: 'Minta Telefon Zrt.', memo: 'kártyás vásárlás', ext: '777001|-8490' }], 'MagNet');
    const r = await ingest(t, {
      transactions: [
        { _id: 'm1', bookingDate: day(-4), direction: 'expense', amount: 8490, counterparty: { name: 'MINTA TELEFON' }, account: ACC },
        { _id: 'm2', bookingDate: day(-1), direction: 'expense', amount: 15990, counterparty: { name: 'Szoftver Webshop' }, account: ACC },
      ],
      balances: { [ACC]: 1250000 },
    });
    expect(r.status).toBe(200);
    expect(txs(t).map((x) => x.amount)).toEqual([-8490, -15990]);
    const acc = t.sql.prepare("SELECT balance, iban FROM bank_accounts WHERE bank_name = 'MagNet'").get() as any;
    expect(acc.balance).toBe(1250000);
  });

  it('a későbbi feltöltésben megjelenő, azonos napi és összegű ÚJ tétel nem vész el', async () => {
    t = await createTestApp();
    seedTree(t);
    const first = { _id: 'a1', bookingDate: day(-3), direction: 'expense', amount: 1873, counterparty: { name: 'Minta API Inc' }, account: ACC };
    await ingest(t, { transactions: [first] });
    expect(txs(t)).toHaveLength(1);
    // a bank visszamenő dátummal könyvel még egy ugyanakkora vásárlást; a Mac a 7 napos átfedés miatt az elsőt is újra küldi
    await ingest(t, {
      transactions: [first, { _id: 'a2', bookingDate: day(-3), direction: 'expense', amount: 1873, counterparty: { name: 'Minta API Inc' }, account: ACC }],
    });
    expect(txs(t).map((x) => x.ext_id).sort()).toEqual(['a8:a1', 'a8:a2']);
  });

  it('két külön feltöltésben érkező, különböző aggreg8-azonosítójú azonos tétel két külön banki tétel', async () => {
    t = await createTestApp();
    seedTree(t);
    const mk = (id: string) => ({ _id: id, bookingDate: day(-2), direction: 'expense', amount: 199, counterparty: { name: 'Tranzakciós díj' }, account: ACC });
    await ingest(t, { transactions: [mk('f1')] });
    await ingest(t, { transactions: [mk('f2')] });
    expect(txs(t)).toHaveLength(2);
  });
});

describe('Enable Banking (PSD2) szinkron', () => {
  it('csak a könyvelt tételek, előjelesen, a partner az ellenoldal; az egyenleg frissül; újrafuttatva nincs duplikáció', async () => {
    const kp = (await crypto.subtle.generateKey(
      { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
      true,
      ['sign', 'verify'],
    )) as CryptoKeyPair;
    const pkcs8 = Buffer.from(await crypto.subtle.exportKey('pkcs8', kp.privateKey)).toString('base64');
    const pem = `-----BEGIN PRIVATE KEY-----\n${pkcs8}\n-----END PRIVATE KEY-----`;
    t = await createTestApp({ env: { EB_APP_ID: 'teszt-app', EB_PRIVATE_KEY: pem } as any });
    seedTree(t);
    t.sql
      .prepare("INSERT INTO bank_accounts (id, provider, bank_name, label, eb_account_uid, valid_until) VALUES ('acc_eb', 'enablebanking', 'Minta Bank', 'Üzleti', 'uid-1', ?)")
      .run(new Date(Date.now() + 30 * 86400_000).toISOString());
    const calls: string[] = [];
    vi.stubGlobal('fetch', async (url: string) => {
      calls.push(String(url));
      if (String(url).includes('/balances'))
        return new Response(JSON.stringify({ balances: [{ balance_type: 'ITBD', balance_amount: { amount: '1000.00', currency: 'HUF' } }, { balance_type: 'CLAV', balance_amount: { amount: '2345678.40', currency: 'HUF' } }] }));
      return new Response(
        JSON.stringify({
          transactions: [
            { entry_reference: 'r1', status: 'BOOK', booking_date: day(-2), credit_debit_indicator: 'CRDT', transaction_amount: { amount: '150000.00', currency: 'HUF' }, debtor: { name: 'Alfa Kft.' }, remittance_information: ['Számla 2026-000040'] },
            { entry_reference: 'r2', status: 'BOOK', booking_date: day(-1), credit_debit_indicator: 'DBIT', transaction_amount: { amount: '4990.00', currency: 'HUF' }, creditor: { name: 'Minta Tárhely Kft.' } },
            { entry_reference: 'r3', status: 'PDNG', booking_date: day(0), credit_debit_indicator: 'DBIT', transaction_amount: { amount: '999.00', currency: 'HUF' }, creditor: { name: 'Függő Bolt' } },
          ],
        }),
      );
    });
    const r1 = await syncBanks(t.env);
    expect(r1.errors).toEqual([]);
    expect(txs(t).map((x) => [x.amount, x.partner, x.ext_id])).toEqual([
      [150000, 'Alfa Kft.', 'r1'],
      [-4990, 'Minta Tárhely Kft.', 'r2'],
    ]);
    expect((t.sql.prepare("SELECT balance FROM bank_accounts WHERE id = 'acc_eb'").get() as any).balance).toBe(2345678);
    await syncBanks(t.env);
    expect(txs(t)).toHaveLength(2);
    expect(calls.some((u) => u.includes('/accounts/uid-1/transactions'))).toBe(true);
  });

  it('lejárt banki hozzájárulásnál hibát jelez a számlán, nem kér tételeket', async () => {
    t = await createTestApp({ env: { EB_APP_ID: 'x', EB_PRIVATE_KEY: 'x' } as any });
    seedTree(t);
    t.sql
      .prepare("INSERT INTO bank_accounts (id, provider, bank_name, label, eb_account_uid, valid_until) VALUES ('acc_eb', 'enablebanking', 'Minta Bank', 'Üzleti', 'uid-1', ?)")
      .run(new Date(Date.now() - 86400_000).toISOString());
    const f = vi.fn();
    vi.stubGlobal('fetch', f);
    const r = await syncBanks(t.env);
    expect(r.errors[0]).toMatch(/lejárt/);
    expect(f).not.toHaveBeenCalled();
    expect((t.sql.prepare("SELECT last_error FROM bank_accounts WHERE id = 'acc_eb'").get() as any).last_error).toMatch(/lejárt/);
  });
});
