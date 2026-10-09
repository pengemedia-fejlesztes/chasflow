import { describe, expect, it } from 'vitest';
import { normalizeImportRow, offerAmount, offerLeaf, parseCategory, parseDate } from '../shared/categories';
import { matchPlan, partnerKey, suggestLeaf } from '../shared/match';
import { addMonths, buildIndex, buildMatrix, defaultFilters, monthRange, outlook } from '../shared/model';
import type { Entry } from '../shared/types';

describe('kategória értelmezés', () => {
  it('kiadás csoport + alkategória', () => {
    expect(parseCategory('3 Működési költségek - KIVA - Munkatárs bővítés')).toEqual({
      section: 'out',
      group: '3 Működési költségek',
      leaf: 'KIVA - Munkatárs bővítés',
    });
    expect(parseCategory('1 - Ajánlatok - Alvállalkozói ajánlatok')).toEqual({ section: 'out', group: '1 Ajánlatok', leaf: 'Alvállalkozói ajánlatok' });
  });
  it('bevétel', () => {
    expect(parseCategory('Projektek - Alfa')).toEqual({ section: 'in', group: 'Projektek', leaf: 'Alfa' });
    expect(parseCategory('Ajánlatok', 'GAMMA-SEO-448.000')).toEqual({ section: 'in', group: 'Ajánlatok', leaf: 'GAMMA' });
  });
  it('ajánlat összeg és név', () => {
    expect(offerAmount('Minta Ügyfél - setup-762.000')).toBe(762000);
    expect(offerAmount('Bétaklinika-3.270.000')).toBe(3270000);
    expect(offerLeaf('Delta+ outlet - egyszeri díj-980.000')).toBe('Delta+ outlet');
  });
  it('dátum', () => {
    expect(parseDate('2026. 10. 01.')).toBe('2026-10-01');
    expect(parseDate(46296)).toBe('2026-10-01');
  });
  it('import sor: 0 Ft tény kimarad, ajánlat terv lesz', () => {
    expect(normalizeImportRow({ date: '2026. 09. 01.', name: 'AM', category: '5 Penge Bővítés - AM', amount: 0 }, 'actual')).toBeNull();
    const r = normalizeImportRow({ date: '2026. 11. 01.', name: 'Bétaklinika-3.270.000', category: 'Ajánlatok', amount: 0 }, 'plan')!;
    expect(r).toMatchObject({ amount: 3270000, tentative: true, leaf: 'Bétaklinika', name: 'Bétaklinika' });
  });
});

const mk = (p: Partial<Entry>): Entry => ({
  id: Math.random().toString(36),
  kind: 'actual',
  date: '2026-01-01',
  leaf_id: 'l_in',
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
});

describe('cashflow modell', () => {
  const groups = [
    { id: 'g_in', section: 'in' as const, label: 'Projektek', sort: 5 },
    { id: 'g_out', section: 'out' as const, label: '3 Működési költségek', sort: 30 },
  ];
  const leaves = [
    { id: 'l_in', group_id: 'g_in', label: 'Alfa', sort: 0, archived: 0 },
    { id: 'l_out', group_id: 'g_out', label: 'Iroda', sort: 0, archived: 0 },
    { id: 'l_empty', group_id: 'g_out', label: 'Üres', sort: 0, archived: 0 },
  ];
  const today = '2026-10-09';
  const entries: Entry[] = [];
  // 12 hónap tény: +600e bevétel, −200e iroda
  for (const ym of monthRange('2025-10', '2026-09')) {
    entries.push(mk({ date: ym + '-08', leaf_id: 'l_in', amount: 600000 }));
    entries.push(mk({ date: ym + '-01', leaf_id: 'l_out', amount: -200000 }));
  }
  entries.push(mk({ kind: 'plan', date: '2026-10-20', leaf_id: 'l_in', amount: 600000 }));
  entries.push(mk({ kind: 'plan', date: '2026-11-20', leaf_id: 'l_in', amount: 600000 }));
  entries.push(mk({ kind: 'plan', date: '2026-11-20', leaf_id: 'l_in', amount: 1000000, tentative: 1 }));
  const bundle = { groups, leaves, entries, accounts: [], settings: { opening_balance: '1000000' }, today };
  const ix = buildIndex(bundle);

  it('számított egyenleg = nyitó + tények', () => {
    expect(ix.anchor).toBe(1000000 + 12 * 400000);
    expect(ix.anchorSource).toBe('computed');
  });
  it('banki egyenleg az irányadó, ha van', () => {
    const b = buildIndex({
      ...bundle,
      accounts: [
        {
          id: 'a',
          provider: 'manual',
          bank_name: 'BiNX',
          label: '',
          iban: null,
          currency: 'HUF',
          balance: 7000000,
          balance_at: 1,
          valid_until: null,
          last_sync: null,
          last_error: null,
          active: 1,
        },
      ],
    });
    expect(b.anchor).toBe(7000000);
  });
  it('mátrix: csak nem üres sorok, előrejelzés + becslés', () => {
    const f = { ...defaultFilters(today), to: addMonths('2026-10', 3) };
    const m = buildMatrix(ix, f);
    expect(m.rows.find((r) => r.id === 'l_empty')).toBeUndefined();
    // okt: tény oszlop + terv oszlop
    expect(m.columns[0].kind).toBe('actual');
    expect(m.columns[1].kind).toBe('plan');
    const oct = m.balance[1];
    expect(oct).toBe(ix.anchor + 600000);
    // nov: terv 600e bevétel; iroda becslés −200e (nincs terve)
    const nov = m.balance[2];
    expect(nov).toBe(oct + 600000 - 200000);
    // ajánlat csak szűrővel
    const m2 = buildMatrix(ix, { ...f, includeOffers: true });
    expect(m2.balance[2]).toBe(nov + 1000000);
  });
  it('múltbeli hónap záró egyenlege', () => {
    const m = buildMatrix(ix, { ...defaultFilters(today), from: '2026-08', to: '2026-10', mode: 'actual' });
    expect(m.balance[m.balance.length - 1]).toBe(ix.anchor);
    expect(m.balance[1]).toBe(ix.anchor); // szept vége → okt-ben nincs tény
    expect(m.balance[0]).toBe(ix.anchor - 400000);
  });
  it('12 hónapos kitekintés', () => {
    const o = outlook(ix, { includeOffers: false, estimate: true });
    expect(o.last12.net).toBe(12 * 400000);
    expect(o.months.length).toBe(13);
  });
});

describe('banki párosítás', () => {
  it('partner kulcs', () => expect(partnerKey('Alfa Kft.')).toBe('alfa'));
  it('kategória javaslat név alapján', () => {
    const leaves = [{ id: 'l1', group_id: 'g', label: 'Alfa', sort: 0, archived: 0 }];
    expect(suggestLeaf({ date: '2026-10-08', amount: 609600, partner: 'ALFA KFT', memo: '' }, {}, leaves, () => 'in')).toBe('l1');
  });
  it('terv párosítás összeg + számlaszám', () => {
    const plans = [
      mk({ id: 'p1', kind: 'plan', date: '2026-10-09', leaf_id: 'l1', amount: 609600 }),
      mk({ id: 'p2', kind: 'plan', date: '2026-10-09', leaf_id: 'l1', amount: 571500 }),
    ];
    expect(matchPlan({ date: '2026-10-10', amount: 571500, partner: 'Alfa', memo: '', leaf_id: 'l1' }, plans)!.id).toBe('p2');
    expect(matchPlan({ date: '2026-10-10', amount: 500000, partner: 'X', memo: 'SZ-2026/118', leaf_id: null }, plans, { p1: 'SZ-2026/118' })!.id).toBe('p1');
    expect(matchPlan({ date: '2026-10-10', amount: -571500, partner: 'Alfa', memo: '', leaf_id: 'l1' }, plans)).toBeNull();
  });
});

describe('jövőbeli dátumú tény', () => {
  it('a lezárt terv helyett a tény számít a hónapjában', () => {
    const groups = [{ id: 'g', section: 'in' as const, label: 'Projektek', sort: 5 }];
    const leaves = [{ id: 'l', group_id: 'g', label: 'X', sort: 0, archived: 0 }];
    const base = { groups, leaves, accounts: [], settings: {}, today: '2026-10-09' };
    const open = buildIndex({ ...base, entries: [mk({ id: 'p', kind: 'plan', date: '2026-10-20', leaf_id: 'l', amount: 100 })] });
    const closed = buildIndex({
      ...base,
      entries: [
        mk({ id: 'p', kind: 'plan', date: '2026-10-20', leaf_id: 'l', amount: 100, done: 1 }),
        mk({ kind: 'actual', date: '2026-10-12', leaf_id: 'l', amount: 100 }),
      ],
    });
    const f = { ...defaultFilters('2026-10-09'), estimate: false };
    expect(buildMatrix(closed, f).balance[1]).toBe(buildMatrix(open, f).balance[1]);
  });
});
