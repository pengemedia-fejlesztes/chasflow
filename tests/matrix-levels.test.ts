import { describe, expect, it } from 'vitest';
import { displayGroup, groupPath } from '../shared/categories';
import { buildIndex, buildMatrix, defaultFilters } from '../shared/model';

const today = '2026-11-07';
const base = (o: any) => ({
  id: o.id,
  kind: 'plan',
  series_id: null,
  done: 0,
  tentative: 0,
  source: 'manual',
  ext_ref: null,
  link_id: null,
  note: null,
  name: 'x',
  ...o,
});
const data: any = {
  today,
  groups: [
    { id: 'ga', section: 'in', label: 'Ajánlatok', sort: 0 },
    { id: 'gp', section: 'in', label: 'Projektek', sort: 1 },
    { id: 'gk', section: 'out', label: '3 Működési költségek', sort: 2 },
  ],
  leaves: [
    { id: 'kal', group_id: 'gp', label: 'Kalmia', sort: 0, archived: 0 },
    { id: 'm3', group_id: 'ga', label: 'M3', sort: 0, archived: 0 },
    { id: 'iro', group_id: 'gk', label: 'Iroda', sort: 0, archived: 0 },
  ],
  series: [],
  entries: [
    base({ id: 'a', date: '2026-12-10', leaf_id: 'kal', amount: 1000 }),
    base({ id: 'b', date: '2026-12-10', leaf_id: 'm3', amount: 500, tentative: 1 }),
    base({ id: 'c', date: '2026-12-10', leaf_id: 'iro', amount: -200 }),
  ],
  accounts: [],
  bankTx: [],
  billingo: [],
  settings: {},
};

describe('Bevétel / Ajánlatok / Kiadás szintek', () => {
  const ix = buildIndex(data);
  const m = buildMatrix(ix, { ...defaultFilters(today), includeOffers: true, estimate: false });
  const col = m.columns.findIndex((c) => c.last === '2026-12');

  it('a bevételi partnerek közvetlenül a Bevétel alatt vannak, nincs Projektek sor', () => {
    expect(m.rows.map((r) => `${r.type}:${r.label}`)).toEqual([
      'section:Bevétel',
      'leaf:Kalmia',
      'section:Ajánlatok',
      'leaf:M3',
      'section:Kiadás',
      'group:3 Működési költségek',
      'leaf:Iroda',
    ]);
  });
  it('az Ajánlatok nem számít bele a Bevételbe, a havi cashflow-ba igen (kapcsolóval)', () => {
    expect(m.rows.find((r) => r.label === 'Bevétel')!.cells[col].v).toBe(1000);
    expect(m.rows.find((r) => r.label === 'Ajánlatok')!.cells[col].v).toBe(500);
    expect(m.net[col]).toBe(1300);
  });
  it('megjelenített név', () => {
    expect(displayGroup('Projektek')).toBe('Bevétel');
    expect(groupPath('in', 'Projektek')).toBe('Bevétel');
    expect(groupPath('in', 'Ajánlatok')).toBe('Ajánlatok');
    expect(groupPath('out', '3 Működési költségek')).toBe('Kiadás › 3 · Működési költségek');
  });
});
