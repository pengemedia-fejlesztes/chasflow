// Banki tétel → terv javaslat (matchPlan), kategória-javaslat (suggestLeaf) és a javasolt terv lezárhatósága (planFitsTx).
import { describe, expect, it } from 'vitest';
import { matchContains, matchPlan, partnerKey, planFitsTx, suggestLeaf } from '../../src/shared/match';
import type { Entry, Leaf } from '../../src/shared/types';

const plan = (o: Partial<Entry> & { id: string; date: string; leaf_id: string; amount: number }): Entry =>
  ({ kind: 'plan', name: '', done: 0, tentative: 0, source: 'manual', series_id: null, ext_ref: null, link_id: null, note: null, updated_at: 0, ...o }) as Entry;

const labels: Record<string, string> = { l_dom: 'Domain-Tárhely', l_alfa: 'Alfa Kft.', l_konyv: 'Könyvelés' };
const label = (id: string) => labels[id] || '';

describe('terv-javaslat (matchPlan)', () => {
  it('a tétel hónapjának tervét javasolja, nem a következő hónapét (a lejárt havi terv különben nyitva maradna)', () => {
    const plans = [
      plan({ id: 'okt', date: '2026-10-01', period: '2026-10', leaf_id: 'l_dom', amount: -8250, name: 'Minta Tárhely – 2026. október' }),
      plan({ id: 'nov', date: '2026-11-03', period: '2026-11', leaf_id: 'l_dom', amount: -8250, name: 'Minta Tárhely – 2026. november' }),
    ];
    const tx = { date: '2026-10-20', amount: -10240, partner: 'Minta Tárhely Zrt.', memo: 'DB/1234', leaf_id: 'l_dom' };
    expect(matchPlan(tx, plans, {}, label)?.id).toBe('okt');
  });

  it('közös kategóriában egy másik szolgáltató jelentősen eltérő összegű tervét nem javasolja', () => {
    const plans = [plan({ id: 'masik', date: '2026-10-25', leaf_id: 'l_dom', amount: -18200, name: 'Minta Tárhely Zrt. – 2026. október' })];
    const tx = { date: '2026-10-09', amount: -31680, partner: 'Példa Webszolgáltató Kft.', memo: 'PW / 2026-000170', leaf_id: 'l_dom' };
    expect(matchPlan(tx, plans, {}, label)).toBeNull();
    // ha a terv a partneré (a neve szerepel a tervben), az eltérő összeg ellenére javasolja (az eltérést a riasztás jelzi)
    const own = [plan({ id: 'sajat', date: '2026-10-25', leaf_id: 'l_dom', amount: -18200, name: 'Példa Webszolgáltató – október' })];
    expect(matchPlan(tx, own, {}, label)?.id).toBe('sajat');
  });

  it('bevételnél a partner-kategória terve eltérő összeggel is javasolt (a kategória maga a partner)', () => {
    const plans = [plan({ id: 'havi', date: '2026-10-10', leaf_id: 'l_alfa', amount: 500000, name: 'Havi díj' })];
    const tx = { date: '2026-10-12', amount: 400000, partner: 'ALFA KFT.', memo: 'részlet', leaf_id: 'l_alfa' };
    expect(matchPlan(tx, plans, {}, label)?.id).toBe('havi');
  });

  it('a számla sorszáma a közleményben más kategóriában is párosít; ellentétes irányú tervet soha', () => {
    const plans = [plan({ id: 'szla', date: '2026-10-05', leaf_id: 'l_alfa', amount: 254000, name: 'Projekt' })];
    expect(matchPlan({ date: '2026-10-08', amount: 254000, partner: 'X', memo: 'Szla: MINTA/2026-000045', leaf_id: null }, plans, { szla: 'MINTA/2026-000045' })?.id).toBe('szla');
    expect(matchPlan({ date: '2026-10-08', amount: -254000, partner: 'X', memo: '', leaf_id: 'l_alfa' }, plans)).toBeNull();
  });

  it('a lezárt és a túl régi / túl távoli terv kimarad', () => {
    const plans = [
      plan({ id: 'kesz', date: '2026-10-05', leaf_id: 'l_konyv', amount: -36000, done: 1 }),
      plan({ id: 'regi', date: '2026-07-01', leaf_id: 'l_konyv', amount: -36000 }),
    ];
    expect(matchPlan({ date: '2026-10-06', amount: -36000, partner: 'Minta Könyvelő', memo: '', leaf_id: 'l_konyv' }, plans)).toBeNull();
  });
});

describe('a javasolt terv lezárhatósága (planFitsTx)', () => {
  const p = { leaf_id: 'l_konyv', amount: -36000 };
  it('azonos kategória és legalább a terv 30%-a', () => {
    expect(planFitsTx({ amount: -36000 }, 'l_konyv', p)).toBe(true);
    expect(planFitsTx({ amount: -12000 }, 'l_konyv', p)).toBe(true);
  });
  it('kis banki díj, más kategória, ellentétes irány: nem', () => {
    expect(planFitsTx({ amount: -92 }, 'l_konyv', p)).toBe(false);
    expect(planFitsTx({ amount: -36000 }, 'l_dom', p)).toBe(false);
    expect(planFitsTx({ amount: 36000 }, 'l_konyv', p)).toBe(false);
    expect(planFitsTx({ amount: -36000 }, null, p)).toBe(false);
  });
});

describe('kategória-javaslat', () => {
  const leaves: Leaf[] = [
    { id: 'l_bank', group_id: 'g', label: 'Bank költség', sort: 0, archived: 0 },
    { id: 'l_jar', group_id: 'g', label: 'Járulékok', sort: 0, archived: 0 },
    { id: 'l_alfa', group_id: 'gi', label: 'Alfa Kft.', sort: 0, archived: 0 },
  ];
  const sec = (id: string) => (id === 'l_alfa' ? 'in' : 'out');
  it('a „tartalmazza” szabály megelőzi a tanult partner-szabályt, a hosszabb minta nyer', () => {
    const contains = [
      { pattern: 'dij', leaf_id: 'l_bank' },
      { pattern: 'egyes meghat', leaf_id: 'l_jar' },
    ];
    const tx = { date: '2026-10-09', amount: -1000, partner: 'Egyes meghat. juttatás SZJA', memo: 'adószám' };
    expect(suggestLeaf(tx, { [partnerKey(tx.partner)]: 'l_bank' }, leaves, sec, contains)).toBe('l_jar');
  });
  it('a szabály iránya számít: kiadási szabály bevételre nem illik', () => {
    expect(matchContains({ date: '', amount: 5000, partner: 'Visszatérített díj', memo: '' }, [{ pattern: 'dij', leaf_id: 'l_bank' }], sec)).toBeNull();
  });
});

describe('terv-javaslat – adók', () => {
  it('a NAV-nak utalt ÁFA a hónap ÁFA-tervét kapja akkor is, ha a terv csak becslés volt (a „NAV Áfa” szó a kategóriában)', () => {
    const plans = [plan({ id: 'afa_okt', date: '2026-10-01', period: '2026-10', leaf_id: 'l_afa', amount: -620000, name: 'ÁFA – 2026. október' })];
    const tx = { date: '2026-10-20', amount: -400000, partner: 'NAV Áfa', memo: 'adószám', leaf_id: 'l_afa' };
    expect(matchPlan(tx, plans, {}, (id) => (id === 'l_afa' ? 'ÁFA' : ''))?.id).toBe('afa_okt');
  });
});
