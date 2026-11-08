// A számok nézetenként: szűrők, ajánlatok, becslés, hónaphatárok, terv–tény és eredmény-cél – ugyanazokra az adatokra
// ugyanazt kell mutatniuk, és egyezniük kell a kézzel számolt értékkel.
import { describe, expect, it } from 'vitest';
import { targetTracking } from '../../src/shared/insights';
import {
  actualBalanceAt,
  buildEstimates,
  buildIndex,
  buildMatrix,
  defaultFilters,
  endOfMonth,
  outlook,
  planCorrections,
  type Filters,
} from '../../src/shared/model';
import { closedMonth, planVsActual, type MonthStat } from '../../src/shared/planactual';
import type { Entry } from '../../src/shared/types';

let n = 0;
const E = (p: Partial<Entry>): Entry =>
  ({
    id: 'v' + ++n,
    kind: 'plan',
    date: '2026-11-10',
    leaf_id: 'minta',
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
  { id: 'gin', section: 'in' as const, label: 'Projektek', sort: 0 },
  { id: 'gaj', section: 'in' as const, label: 'Ajánlatok', sort: 1 },
  { id: 'gmunka', section: 'out' as const, label: '1 Munkatársak jövedelmei', sort: 0 },
  { id: 'gmuk', section: 'out' as const, label: '3 Működési költségek', sort: 1 },
];
const leaves = [
  { id: 'minta', group_id: 'gin', label: 'Minta Kft.', sort: 0, archived: 0 },
  { id: 'pelda', group_id: 'gin', label: 'Példa Bt.', sort: 1, archived: 0 },
  { id: 'uj', group_id: 'gaj', label: 'Új Ügyfél Zrt.', sort: 0, archived: 0 },
  { id: 'ber', group_id: 'gmunka', label: 'Kovács Anna', sort: 0, archived: 0 },
  { id: 'konyv', group_id: 'gmuk', label: 'Könyvelés', sort: 0, archived: 0 },
  { id: 'regi', group_id: 'gmuk', label: 'Régi szolgáltató', sort: 1, archived: 1 },
];
const ixOf = (entries: Entry[], today = '2026-11-07') =>
  buildIndex({ groups, leaves, entries, accounts: [], settings: { opening_balance: '3000000' }, today });

describe('szűrők: a sorok szűrődnek, az egyenleg nem', () => {
  const entries = [
    E({ kind: 'actual', date: '2026-10-10', amount: 800_000 }),
    E({ kind: 'actual', date: '2026-10-12', leaf_id: 'ber', amount: -450_000 }),
    E({ date: '2026-12-10', amount: 800_000 }),
    E({ date: '2026-12-10', leaf_id: 'pelda', amount: 200_000 }),
    E({ date: '2026-12-05', leaf_id: 'ber', amount: -450_000, name: 'Munkabér – 2026. december' }),
    E({ date: '2026-12-15', leaf_id: 'konyv', amount: -60_000, name: 'Könyvelési díj – 2026. december' }),
  ];
  const ix = ixOf(entries);
  const base: Filters = { ...defaultFilters(ix.today), from: '2026-10', to: '2026-12', estimate: false };
  const all = buildMatrix(ix, base);
  const col = (m: ReturnType<typeof buildMatrix>, key: string) => m.columns.findIndex((c) => c.key === key);
  it('teljes nézet: Bevétel − Kiadás = Havi cashflow, kézzel számolva', () => {
    const i = col(all, '2026-12p');
    const sec = (id: string) => all.rows.find((r) => r.type === 'section' && r.id === id)!.cells[i].v;
    expect(sec('in')).toBe(1_000_000);
    expect(sec('out')).toBe(510_000);
    expect(all.net[i]).toBe(490_000);
    expect(all.filtered).toBe(false);
  });
  for (const [label, p] of [
    ['csak kiadás', { section: 'out' as const }],
    ['egy mappa', { groupId: 'gmuk' }],
    ['keresés', { search: 'könyvel' }],
  ] as const) {
    it(`${label}: a záró egyenleg-sor ugyanaz, mint szűrés nélkül`, () => {
      const m = buildMatrix(ix, { ...base, ...p });
      expect(m.filtered).toBe(true);
      expect(m.balance).toEqual(all.balance);
    });
  }
  it('keresés: csak a találat sora és összege', () => {
    const m = buildMatrix(ix, { ...base, search: 'könyvel' });
    expect(m.rows.filter((r) => r.type === 'leaf').map((r) => r.id)).toEqual(['konyv']);
    expect(m.net[col(m, '2026-12p')]).toBe(-60_000);
  });
});

describe('ajánlatok: külön felső szint, a Bevételbe nem számít', () => {
  const entries = [
    E({ date: '2026-12-10', amount: 800_000 }),
    E({ date: '2026-12-20', leaf_id: 'uj', amount: 1_500_000, tentative: 1, name: 'Webshop fejlesztés' }),
    // más mappában lévő partner ajánlata is az Ajánlatok alatt látszik
    E({ date: '2026-12-22', leaf_id: 'pelda', amount: 300_000, tentative: 1, name: 'Kampány' }),
  ];
  const ix = ixOf(entries);
  const f: Filters = { ...defaultFilters(ix.today), to: '2026-12', estimate: false };
  for (const includeOffers of [false, true]) {
    it(`Bevétel sora ajánlatok nélkül; a Havi cashflow és az egyenleg ${includeOffers ? 'ajánlatokkal' : 'ajánlatok nélkül'}`, () => {
      const m = buildMatrix(ix, { ...f, includeOffers });
      const i = m.columns.findIndex((c) => c.key === '2026-12p');
      const bev = m.rows.find((r) => r.type === 'section' && r.id === 'in')!;
      const aj = m.rows.find((r) => r.type === 'section' && r.label === 'Ajánlatok')!;
      expect(bev.cells[i].v).toBe(800_000);
      expect(aj.cells[i].v).toBe(includeOffers ? 1_800_000 : 0);
      expect(m.net[i]).toBe(800_000 + (includeOffers ? 1_800_000 : 0));
      expect(m.balance[i] - m.balance[i - 1]).toBe(m.net[i]);
      // a más mappában lévő partner sora a saját mappájában nem duplázza az ajánlatot
      const peldaRows = m.rows.filter((r) => r.type === 'leaf' && r.id === 'pelda');
      expect(peldaRows.reduce((s, r) => s + r.cells[i].v, 0)).toBe(includeOffers ? 300_000 : 0);
    });
  }
});

describe('becslés: rendszeres tétel a múlt alapján, csak ahol nincs terv', () => {
  // könyvelés: az elmúlt 6 lezárt hónapból 5-ben fizettünk (60 000 / 62 000 / 58 000 / 60 000 / 60 000)
  const hist = [
    ['2026-05-08', -60_000],
    ['2026-06-08', -62_000],
    ['2026-07-08', -58_000],
    ['2026-09-08', -60_000],
    ['2026-10-08', -60_000],
  ] as const;
  const entries = [
    ...hist.map(([date, amount]) => E({ kind: 'actual', date, leaf_id: 'konyv', amount, name: 'Könyvelés' })),
    E({ date: '2026-11-15', leaf_id: 'konyv', amount: -60_000, name: 'Könyvelési díj – 2026. november' }),
    E({ date: '2026-12-15', leaf_id: 'konyv', amount: -60_000, name: 'Könyvelési díj – 2026. december' }),
    // archivált kategória: nincs becslés, hiába volt rendszeres
    ...['2026-05', '2026-06', '2026-07', '2026-08', '2026-09', '2026-10'].map((ym) => E({ kind: 'actual', date: ym + '-03', leaf_id: 'regi', amount: -9_990 })),
    // csak 4 hónapban: nem rendszeres
    ...['2026-05', '2026-07', '2026-09', '2026-10'].map((ym) => E({ kind: 'actual', date: ym + '-20', leaf_id: 'pelda', amount: 150_000 })),
  ];
  const ix = ixOf(entries);
  const est = buildEstimates(ix, '2027-02');
  it('az utolsó tervezett hónap után, az 5 hónap átlagával', () => {
    expect([...(est.get('konyv') || [])]).toEqual([
      ['2027-01', -60_000],
      ['2027-02', -60_000],
    ]);
  });
  it('archivált és nem elég gyakori kategóriára nincs becslés', () => {
    expect(est.has('regi')).toBe(false);
    expect(est.has('pelda')).toBe(false);
  });
  it('a becslés a táblázatban és az előrejelzésben ugyanannyi', () => {
    const f: Filters = { ...defaultFilters(ix.today), to: '2027-02', estimate: true };
    const m = buildMatrix(ix, f);
    const i = m.columns.findIndex((c) => c.key === '2027-01p');
    expect(m.net[i]).toBe(-60_000);
    expect(m.balance[i] - m.balance[i - 1]).toBe(-60_000);
    expect(outlook(ix, f).months.find((x) => x.ym === '2027-01')!.exp).toBe(60_000);
  });
});

describe('terv-korrekció', () => {
  it.todo(
    'KÉRDÉS (Laci): éves / nem havi terv (pl. éves domain-díj februárban) pontatlansága esetén a korrekció a 90 napos HAVI átlagot ' +
      'teszi a terv helyére – a februári éves díj várható értéke így a havi átlag lesz. Csak havi tervekre kellene alkalmazni?',
  );
  it('havi tervnél a jövőbeli tervhónap várható értéke a 90 napos havi átlag (a terv nem változik)', () => {
    const entries = [
      ...['2026-08-12', '2026-09-12', '2026-10-12'].map((date) => E({ kind: 'actual', date, leaf_id: 'konyv', amount: -66_000 })),
      E({ date: '2026-10-10', leaf_id: 'konyv', amount: -60_000, done: 1, plan_amount: -60_000, bill_amount: -66_000 }),
      E({ date: '2026-12-10', leaf_id: 'konyv', amount: -60_000 }),
    ];
    const ix = ixOf(entries);
    expect(planCorrections(ix).get('konyv')).toBe(-66_000);
    const m = buildMatrix(ix, { ...defaultFilters(ix.today), to: '2026-12', estimate: true });
    const i = m.columns.findIndex((c) => c.key === '2026-12p');
    expect(m.net[i]).toBe(-66_000);
    expect(ix.plan.get('konyv')?.get('2026-12')).toBe(-60_000);
  });
});

describe('hónaphatárok', () => {
  it('a hónap utolsó és a következő első napja külön hónapba esik (szökőév is)', () => {
    expect(endOfMonth('2028-02')).toBe('2028-02-29');
    expect(endOfMonth('2026-02')).toBe('2026-02-28');
    const entries = [
      E({ kind: 'actual', date: '2026-10-31', amount: 100_000 }),
      E({ kind: 'actual', date: '2026-11-01', amount: 10_000 }),
      E({ kind: 'actual', date: '2025-12-31', amount: 1_000 }),
      E({ kind: 'actual', date: '2026-01-01', amount: 100 }),
    ];
    const ix = ixOf(entries);
    expect(ix.actual.get('minta')?.get('2026-10')).toBe(100_000);
    expect(ix.actual.get('minta')?.get('2026-11')).toBe(10_000);
    expect(actualBalanceAt(ix, '2026-10')).toBe(ix.anchor - 10_000);
    expect(actualBalanceAt(ix, '2025-12')).toBe(ix.anchor - 10_000 - 100_000 - 100);
  });
  it('a mai napon rögzített tény már a mai egyenleg része, a holnapi még nem', () => {
    const ix = ixOf([E({ kind: 'actual', date: '2026-11-07', amount: 5_000 }), E({ kind: 'actual', date: '2026-11-08', amount: 7_000 })]);
    expect(ix.anchor).toBe(3_005_000);
  });
});

describe('terv–tény és eredmény-cél ugyanazokból a számokból', () => {
  const entries = [
    E({ date: '2026-10-10', amount: 800_000, done: 1, link_id: 'okt_be' }),
    E({ id: 'okt_be', kind: 'actual', date: '2026-10-14', amount: 780_000 }),
    E({ date: '2026-10-05', leaf_id: 'ber', amount: -450_000, done: 1, link_id: 'okt_ki' }),
    E({ id: 'okt_ki', kind: 'actual', date: '2026-10-05', leaf_id: 'ber', amount: -450_000 }),
    E({ date: '2026-11-10', amount: 800_000 }),
    E({ date: '2026-11-03', leaf_id: 'ber', amount: -450_000, done: 1, link_id: 'nov_ki' }),
    E({ id: 'nov_ki', kind: 'actual', date: '2026-11-04', leaf_id: 'ber', amount: -450_000 }),
    E({ date: '2026-11-25', leaf_id: 'uj', amount: 500_000, tentative: 1 }),
  ];
  const ix = ixOf(entries);
  it('terv–tény: a terv = az Áttekintés „terv” módjának összege, a tény = a tény oszlop', () => {
    const [okt, nov] = planVsActual(entries, ix.sectionOf, ['2026-10', '2026-11'], (l) => ix.leafById[l]?.label || '');
    const plan = buildMatrix(ix, { ...defaultFilters(ix.today), from: '2026-10', to: '2026-11', mode: 'plan', estimate: false });
    const act = buildMatrix(ix, { ...defaultFilters(ix.today), from: '2026-10', to: '2026-11', mode: 'actual', estimate: false });
    const sec = (m: ReturnType<typeof buildMatrix>, id: string, i: number) => m.rows.find((r) => r.type === 'section' && r.id === id)!.cells[i].v;
    expect([okt.planIn, okt.planOut]).toEqual([sec(plan, 'in', 0), sec(plan, 'out', 0)]);
    expect([nov.planIn, nov.planOut]).toEqual([sec(plan, 'in', 1), sec(plan, 'out', 1)]);
    expect([okt.actIn, okt.actOut]).toEqual([sec(act, 'in', 0), sec(act, 'out', 0)]);
    expect([okt.planIn, okt.actIn, okt.planOut, okt.actOut]).toEqual([800_000, 780_000, 450_000, 450_000]);
    expect(nov.offerIn).toBe(500_000);
  });
  it('eredmény-cél: múlt = tény, folyó hónap = tény + nyitott terv = az Áttekintés „Havi cashflow” kártyája', () => {
    const [okt, nov] = targetTracking(ix, 300_000, ['2026-10', '2026-11']);
    expect(okt.net).toBe(330_000);
    expect(nov.net).toBe(800_000 - 450_000);
    expect(nov.net).toBe(outlook(ix, { includeOffers: false, estimate: false }).months[0].net);
    expect(nov.offer).toBe(500_000);
  });
  it('lezárt hónap: a terv a pillanatképből, a tény élő – az utólag jóváhagyott banki tétel is látszik, mint az Áttekintésben', () => {
    // október lezárásakor (november 1-jén) készült pillanatkép
    const [snap] = planVsActual(entries, ix.sectionOf, ['2026-10'], (l) => ix.leafById[l]?.label || '');
    const stat: MonthStat = {
      ym: '2026-10',
      plan_in: snap.planIn,
      plan_out: snap.planOut,
      offer_in: snap.offerIn,
      offer_out: snap.offerOut,
      act_in: snap.actIn,
      act_out: snap.actOut,
      closed: 1,
      computed_at: 0,
    };
    // utána: a bank későn hozza az október 20-i javítási díjat, és az októberi bevétel tervét átütemezik novemberre
    const later = [
      ...entries.map((e) => (e.date === '2026-10-10' ? { ...e, date: '2026-11-10' } : e)),
      E({ kind: 'actual', date: '2026-10-20', leaf_id: 'konyv', amount: -120_000, source: 'bank' }),
    ];
    const ix2 = ixOf(later);
    const [live] = planVsActual(later, ix2.sectionOf, ['2026-10'], (l) => ix2.leafById[l]?.label || '');
    const shown = closedMonth(stat, live);
    expect(shown).toEqual({ planIn: 800_000, planOut: 450_000, actIn: 780_000, actOut: 570_000 });
    const act = buildMatrix(ix2, { ...defaultFilters(ix2.today), from: '2026-10', to: '2026-10', mode: 'actual', estimate: false });
    expect(act.rows.find((r) => r.type === 'section' && r.id === 'out')!.cells[0].v).toBe(shown.actOut);
  });
});
