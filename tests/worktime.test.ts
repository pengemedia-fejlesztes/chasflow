import { describe, expect, it } from 'vitest';
import { breakeven, cellMinutes, parseWorkSheets, projectLeaf } from '../shared/worktime';

describe('munkaidő import', () => {
  it('időcellák: Excel-idő, H:MM szöveg, 1 napnál hosszabb idő', () => {
    expect(cellMinutes(0.5)).toBe(720);
    expect(cellMinutes(2.8792)).toBe(4146);
    expect(cellMinutes('14:56')).toBe(896);
    expect(cellMinutes('1:02:30')).toBe(63);
    expect(cellMinutes('')).toBe(0);
  });

  it('a „YYYY.MM-Feladatok” lapokból hónap × projekt × feladat; „Idő (óra)” helyett a H:MM oszlop', () => {
    const rows = parseWorkSheets({
      '2026.08-Feladatok': [
        ['Tag', 'Projekt', 'Idő (óra)', 'Idő (H:MM)'],
        ['SEO', 'Kalmia', 11.4, 11.4 / 24],
        ['SEO', 'Kalmia', 1, 1 / 24],
        ['PM', '360 Marketing', 2, 2 / 24],
      ],
      '2026.08-Összegzés': [['x']],
      '2026.09-Feladatok': [
        ['Tag', 'Projekt', 'Description', 'Idő (H:MM)'],
        ['Fejlesztés', 'Sellvio', '', '1:32'],
      ],
    });
    expect(rows).toEqual([
      { ym: '2026-08', project: '360 Marketing', tag: 'PM', minutes: 120 },
      { ym: '2026-08', project: 'Kalmia', tag: 'SEO', minutes: 744 },
      { ym: '2026-09', project: 'Sellvio', tag: 'Fejlesztés', minutes: 92 },
    ]);
  });

  it('csak „Idő (óra)” oszlop: tizedes óra', () => {
    expect(
      parseWorkSheets({
        '2026.07-Feladatok': [
          ['Tag', 'Projekt', 'Idő (óra)'],
          ['SEO', 'X', 1.5],
        ],
      })[0].minutes,
    ).toBe(90);
  });
});

describe('fedezeti pont', () => {
  const groups: any[] = [
    { id: 'gi', section: 'in', label: 'Projektek' },
    { id: 'go', section: 'out', label: 'Kiadás' },
  ];
  const leaves: any[] = [
    { id: 'kal', group_id: 'gi', label: 'Kalmia' },
    { id: 'mb', group_id: 'gi', label: 'Mr. Big' },
    { id: 'erna', group_id: 'go', label: 'Zuban Erna' },
    { id: 'iroda', group_id: 'go', label: 'Iroda' },
  ];
  const e = (id: string, leaf_id: string, amount: number): any => ({ id, kind: 'actual', date: '2026-09-10', leaf_id, amount, name: '' });

  it('projekt ↔ partner: név / alternatív név, belső projekt nincs', () => {
    const al = new Map([['mb', ['MrBig']]]);
    expect(projectLeaf('Kalmia', leaves.slice(0, 2), al)).toBe('kal');
    expect(projectLeaf('MrBig', leaves.slice(0, 2), al)).toBe('mb');
    expect(projectLeaf('360 Marketing', leaves.slice(0, 2), al)).toBeNull();
  });

  it('munkaköltség az idő arányában; fedezet, fix költség, fedezeti pont', () => {
    const [m] = breakeven({
      months: ['2026-09'],
      entries: [e('a', 'kal', 1_000_000), e('b', 'mb', 500_000), e('c', 'erna', -600_000), e('d', 'iroda', -300_000)],
      leaves,
      groups,
      employees: [{ key: 'erna', name: 'Erna', cost_leaf_id: 'erna' }],
      worktime: [
        { employee: 'erna', ym: '2026-09', project: 'Kalmia', tag: 'SEO', minutes: 60 * 60 },
        { employee: 'erna', ym: '2026-09', project: '360 Marketing', tag: 'PM', minutes: 60 * 60 },
      ],
      aliases: new Map(),
    });
    expect(m.revenue).toBe(1_500_000);
    expect(m.expenses).toBe(900_000);
    expect(m.directLabor).toBe(300_000); // a 120 órából 60 ügyfélprojekten
    expect(m.contribution).toBe(1_200_000);
    expect(m.fixed).toBe(600_000);
    expect(m.breakeven).toBe(750_000); // 600 000 / 0,8
    expect(m.margin).toBe(750_000);
    expect(m.people[0]).toMatchObject({ minutes: 7200, billableMinutes: 3600, cost: 600_000, hourly: 5000 });
    expect(m.projects.find((p) => p.project === 'Kalmia')).toMatchObject({ revenue: 1_000_000, laborCost: 300_000 });
    expect(m.projects.find((p) => p.project === 'Mr. Big')).toMatchObject({ revenue: 500_000, minutes: 0 });
  });
});

import { sheetIdOf } from '../shared/worktime';
describe('elszámoló tábla link', () => {
  it('Google Sheet linkből azonosító, más linkre null', () => {
    expect(sheetIdOf('https://docs.google.com/spreadsheets/d/12J6Lw_U11lWils7dHaZbFk0aGSRcDDKz6cyGLKCEuwk/edit#gid=0')).toBe(
      '12J6Lw_U11lWils7dHaZbFk0aGSRcDDKz6cyGLKCEuwk',
    );
    expect(sheetIdOf('https://example.com/spreadsheets/d/12J6Lw_U11lWils7dHaZbFk0aGSRcDDKz6cyGLKCEuwk')).toBeNull();
    expect(sheetIdOf('')).toBeNull();
  });
});
