// Egyenleg-logika (README): mai egyenleg, múltbeli záró egyenleg, előrejelzés – és hogy ugyanaz a szám
// minden nézetben (táblázat, áttekintő kártyák, mobil) ugyanannyi legyen.
import { describe, expect, it } from 'vitest';
import { actualBalanceAt, buildIndex, buildMatrix, defaultFilters, outlook, projection } from '../../src/shared/model';
import type { BankAccount, Entry } from '../../src/shared/types';

let n = 0;
const E = (p: Partial<Entry>): Entry =>
  ({
    id: 'e' + ++n,
    kind: 'plan',
    date: '2026-11-10',
    leaf_id: 'ugyfel',
    name: '',
    amount: 0,
    series_id: null,
    done: 0,
    tentative: 0,
    source: 'manual',
    ext_ref: null,
    link_id: null,
    note: null,
    ...p,
  }) as Entry;

const groups = [
  { id: 'gin', section: 'in' as const, label: 'Ügyfelek', sort: 0 },
  { id: 'gaj', section: 'in' as const, label: 'Ajánlatok', sort: 1 },
  { id: 'gout', section: 'out' as const, label: 'Működési költségek', sort: 2 },
];
const leaves = [
  { id: 'ugyfel', group_id: 'gin', label: 'Minta Kft.', sort: 0, archived: 0 },
  { id: 'ugyfel2', group_id: 'gin', label: 'Példa Bt.', sort: 1, archived: 0 },
  { id: 'berlet', group_id: 'gout', label: 'Iroda bérlés', sort: 0, archived: 0 },
  { id: 'keret', group_id: 'gout', label: 'Előre nem látható költség', sort: 1, archived: 0 },
];
const bank = (balance: number): BankAccount => ({
  id: 'b1',
  provider: 'manual',
  bank_name: 'Teszt Bank',
  label: 'Üzleti számla',
  iban: null,
  currency: 'HUF',
  balance,
  balance_at: 0,
  valid_until: null,
  last_sync: null,
  last_error: null,
  active: 1,
});
const ixOf = (entries: Entry[], o: { today?: string; accounts?: BankAccount[]; opening?: string } = {}) =>
  buildIndex({
    groups,
    leaves,
    entries,
    accounts: o.accounts ?? [],
    settings: o.opening ? { opening_balance: o.opening } : {},
    today: o.today ?? '2026-11-07',
  });
const noExtras = { includeOffers: false, estimate: false };

describe('mai egyenleg', () => {
  const entries = [
    E({ kind: 'actual', date: '2026-10-05', amount: 1_200_000 }),
    E({ kind: 'actual', date: '2026-10-20', leaf_id: 'berlet', amount: -350_000 }),
    // a mai napnál későbbi kézi tény még nincs a számlán
    E({ kind: 'actual', date: '2026-11-20', leaf_id: 'berlet', amount: -100_000 }),
  ];
  it('bankkapcsolat nélkül: nyitó egyenleg + a mai napig történt tények', () => {
    const ix = ixOf(entries, { opening: '5000000' });
    expect(ix.anchorSource).toBe('computed');
    expect(ix.anchor).toBe(5_000_000 + 1_200_000 - 350_000);
  });
  it('bankkapcsolattal: a (forintos, aktív) banki egyenlegek összege', () => {
    const eur = { ...bank(999), id: 'b2', currency: 'EUR' };
    const off = { ...bank(777), id: 'b3', active: 0 };
    const ix = ixOf(entries, { opening: '5000000', accounts: [bank(4_000_000), { ...bank(1_500_000), id: 'b4' }, eur, off] });
    expect(ix.anchorSource).toBe('bank');
    expect(ix.anchor).toBe(5_500_000);
  });
});

describe('múltbeli hónap záró egyenlege = mai egyenleg − az azóta történt tények', () => {
  const entries = [
    E({ kind: 'actual', date: '2026-09-30', amount: 800_000 }),
    E({ kind: 'actual', date: '2026-10-01', amount: 1_000_000 }),
    E({ kind: 'actual', date: '2026-10-31', leaf_id: 'berlet', amount: -300_000 }),
    E({ kind: 'actual', date: '2026-11-02', leaf_id: 'berlet', amount: -50_000 }),
    E({ kind: 'actual', date: '2026-11-25', leaf_id: 'berlet', amount: -70_000 }), // jövőbeli: nem számít
  ];
  const ix = ixOf(entries, { accounts: [bank(10_000_000)] });
  it('október vége: a novemberi (mai napig) tény visszaadva', () => {
    expect(actualBalanceAt(ix, '2026-10')).toBe(10_050_000);
  });
  it('szeptember vége: az októberi és novemberi tények is', () => {
    expect(actualBalanceAt(ix, '2026-09')).toBe(10_050_000 - 1_000_000 + 300_000);
  });
  it('a táblázat egyenleg-sora a múltbeli hónapokra ugyanezt mutatja', () => {
    const m = buildMatrix(ix, { ...defaultFilters(ix.today), from: '2026-09', to: '2026-11', estimate: false });
    const at = (key: string) => m.balance[m.columns.findIndex((c) => c.key === key)];
    expect(at('2026-09a')).toBe(actualBalanceAt(ix, '2026-09'));
    expect(at('2026-10a')).toBe(actualBalanceAt(ix, '2026-10'));
    expect(at('2026-11a')).toBe(ix.anchor);
  });
});

describe('előrejelzés: mai egyenleg + nyitott tervek', () => {
  it('a folyó hónapban a lejárt, még nyitott tervek is (legfeljebb 4 hónapra visszamenőleg); a kész terv nem', () => {
    const entries = [
      E({ date: '2026-11-20', amount: 600_000 }),
      E({ date: '2026-10-15', leaf_id: 'berlet', amount: -250_000 }), // lejárt, nyitott
      E({ date: '2026-11-03', leaf_id: 'berlet', amount: -250_000, done: 1 }), // kész
      E({ date: '2026-05-10', amount: 90_000 }), // 6 hónapja lejárt: már nem várható
      E({ date: '2026-11-25', amount: 400_000, tentative: 1 }), // ajánlat
    ];
    const ix = ixOf(entries, { accounts: [bank(3_000_000)] });
    expect(projection(ix, noExtras, '2026-11', new Map()).get('2026-11')).toBe(3_000_000 + 600_000 - 250_000);
    expect(projection(ix, { ...noExtras, includeOffers: true }, '2026-11', new Map()).get('2026-11')).toBe(3_000_000 + 600_000 - 250_000 + 400_000);
  });

  it('jövőbeli hónap: az előző záró + a hónap nyitott tervei; a későbbi dátumú tény a saját hónapjában', () => {
    const entries = [
      E({ date: '2026-12-10', amount: 500_000 }),
      E({ date: '2026-12-15', leaf_id: 'berlet', amount: -200_000 }),
      E({ kind: 'actual', date: '2026-12-01', leaf_id: 'berlet', amount: -30_000 }),
    ];
    const ix = ixOf(entries, { accounts: [bank(1_000_000)] });
    const p = projection(ix, noExtras, '2027-01', new Map());
    expect(p.get('2026-11')).toBe(1_000_000);
    expect(p.get('2026-12')).toBe(1_000_000 + 500_000 - 200_000 - 30_000);
    expect(p.get('2027-01')).toBe(p.get('2026-12'));
  });

  describe('keret-terv (Előre nem látható költség) nem vonódik le kétszer', () => {
    it('folyó hónap: a keretből már elköltött (terv nélküli) tény nem csökkenti újra az előrejelzést', () => {
      const entries = [
        E({ leaf_id: 'keret', name: 'Előre nem látható költség – 2026. november', date: '2026-11-30', amount: -50_000 }),
        // már kifizetve, a bankból (benne van a mai egyenlegben)
        E({ kind: 'actual', leaf_id: 'keret', name: 'Papír-írószer', date: '2026-11-04', amount: -20_000 }),
      ];
      const ix = ixOf(entries, { accounts: [bank(2_000_000)] });
      // a keretből még 30 000 maradt elkölthető
      expect(projection(ix, noExtras, '2026-11', new Map()).get('2026-11')).toBe(2_000_000 - 30_000);
    });
    it('folyó hónap: a besorolt nyitott tétel a keretből fogy (nem keret + tétel)', () => {
      const entries = [
        E({ leaf_id: 'keret', name: 'Előre nem látható költség – 2026. november', date: '2026-11-30', amount: -50_000 }),
        E({ leaf_id: 'keret', name: 'Szoftver Kft. – 2026. november', date: '2026-11-15', amount: -4_000 }),
      ];
      const ix = ixOf(entries, { accounts: [bank(2_000_000)] });
      expect(projection(ix, noExtras, '2026-11', new Map()).get('2026-11')).toBe(2_000_000 - 50_000);
    });
    it('lejárt hónap: a keret maradéka megtakarítás, csak a még nyitott besorolt tétel várható', () => {
      const entries = [
        E({ leaf_id: 'keret', name: 'Előre nem látható költség – 2026. október', date: '2026-10-30', amount: -50_000 }),
        E({ leaf_id: 'keret', name: 'Szoftver Kft. – 2026. október', date: '2026-10-15', amount: -4_051 }),
      ];
      const ix = ixOf(entries, { accounts: [bank(2_000_000)] });
      expect(projection(ix, noExtras, '2026-11', new Map()).get('2026-11')).toBe(2_000_000 - 4_051);
    });
  });
});

describe('ugyanaz a szám minden nézetben', () => {
  const entries = [
    E({ kind: 'actual', date: '2026-11-03', amount: 250_000 }),
    E({ kind: 'actual', date: '2026-11-04', leaf_id: 'berlet', amount: -180_000 }),
    E({ date: '2026-11-20', amount: 900_000 }),
    E({ date: '2026-11-03', amount: 250_000, done: 1 }),
    E({ date: '2026-10-25', leaf_id: 'ugyfel2', amount: 150_000 }), // lejárt, nyitott
    E({ date: '2026-12-10', amount: 900_000 }),
    E({ date: '2026-12-05', leaf_id: 'berlet', amount: -180_000 }),
    E({ date: '2027-01-10', amount: 900_000 }),
    E({ date: '2027-01-05', leaf_id: 'berlet', amount: -180_000 }),
    E({ leaf_id: 'keret', name: 'Előre nem látható költség – 2026. november', date: '2026-11-30', amount: -50_000 }),
    E({ kind: 'actual', leaf_id: 'keret', name: 'Futár', date: '2026-11-05', amount: -12_000 }),
    E({ leaf_id: 'keret', name: 'Előre nem látható költség – 2026. december', date: '2026-12-30', amount: -50_000 }),
    E({ date: '2026-12-20', leaf_id: 'ugyfel2', amount: 300_000, tentative: 1 }),
  ];
  const ix = ixOf(entries, { accounts: [bank(4_000_000)] });
  for (const includeOffers of [false, true]) {
    const f = { ...defaultFilters(ix.today), to: '2027-01', includeOffers, estimate: false };
    const m = buildMatrix(ix, f);
    const ol = outlook(ix, f);
    const col = (key: string) => m.columns.findIndex((c) => c.key === key);
    it(`folyó hónap záró egyenlege: táblázat = áttekintő kártya „hó vége”${includeOffers ? ' (ajánlatokkal)' : ''}`, () => {
      expect(m.balance[col('2026-11p')]).toBe(ol.months[0].bal);
    });
    it(`jövőbeli hónap: az egyenleg változása = a táblázat „Havi cashflow” sora${includeOffers ? ' (ajánlatokkal)' : ''}`, () => {
      for (const key of ['2026-12p', '2027-01p']) {
        const i = col(key);
        expect(m.balance[i] - m.balance[i - 1]).toBe(m.net[i]);
      }
    });
    it(`jövőbeli hónap: az áttekintés bevétel / kiadás = a táblázat Bevétel / Kiadás sora${includeOffers ? ' (ajánlatokkal)' : ''}`, () => {
      const i = col('2026-12p');
      const sec = (id: string) => m.rows.filter((r) => r.type === 'section' && r.section === id).reduce((s, r) => s + r.cells[i].v, 0);
      expect(ol.months[1].inc).toBe(sec('in'));
      expect(ol.months[1].exp).toBe(sec('out'));
    });
  }
});
