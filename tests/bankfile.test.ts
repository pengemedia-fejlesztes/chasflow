import { describe, expect, it } from 'vitest';
import { parseBankRows } from '../shared/bankfile';

describe('kivonat felismerés', () => {
  it('BiNX CSV: fejléc előtti sorok, T/J, azonos azonosítójú díj + utalás', () => {
    const rows = [
      ['Konverziós számla száma', '30400001 00000000 00000000'],
      ['E-pénz rendelkezési számla száma', '1'],
      ['', ''],
      [
        'Értéknap',
        'Könyvelés napja',
        'Terhelés vagy jóváírás (T/J)',
        'Összeg',
        'Tranzakció típusa',
        'Tranzakciós kód',
        'Partner neve',
        'Partner bankszámlaszáma',
        'Közlemény',
        'Tranzakció azonosító',
      ],
      ['2026.10.01', '2026.10.01', 'J', '100000', 'Azonnali', 'CDPT', 'Alfa Kft.', 'HU00', 'Penge / 2026-1', 'X1'],
      ['2026.10.02', '2026.10.02', 'T', '-199', 'Tranzakciós díj', 'CHRG', 'Tranzakciós díj', '', 'D-1', 'X2'],
      ['2026.10.02', '2026.10.02', 'T', '-25400', 'Utalás', 'DMCT', 'Béta Kft.', '', 'D-1', 'X2'],
    ];
    const r = parseBankRows(rows, 'BinX_export.csv');
    expect(r.bank).toBe('BiNX');
    expect(r.rows.map((x) => x.amount)).toEqual([100000, -199, -25400]);
    expect(r.rows[0]).toMatchObject({ date: '2026-10-01', partner: 'Alfa Kft.', memo: 'Penge / 2026-1' });
    expect(new Set(r.rows.map((x) => x.ext)).size).toBe(3);
    expect(r.sum).toBe(74401);
  });
  it('MagNet XLS: Értéknap, Ellenpartner, státusz szűrés', () => {
    const rows = [
      ['Kód', 'Értéknap', 'Eredeti értéknap', 'Ellenpartner', 'Ellenszámla', 'Közlemény', 'Összeg', 'Devizanem', 'Státusz'],
      [165074241, '2026.10.08.', '2026.10.08.', 'ANTHROPIC* CLAUDE SUB', '', 'Vásárlás', -85202, 'HUF', 'teljesült'],
      [165074242, '2026.10.08.', '2026.10.08.', 'X', '', '', -1000, 'HUF', 'lemondott'],
      [165074243, '2026.10.09.', '2026.10.09.', 'Gamma Zrt.', '', 'számla', 50000, 'HUF', 'teljesült'],
    ];
    const r = parseBankRows(rows, 'tranzakcioKereses.xls');
    expect(r.bank).toBe('MagNet');
    expect(r.rows.length).toBe(2);
    expect(r.skipped).toBe(1);
    expect(r.rows[0]).toMatchObject({ date: '2026-10-08', amount: -85202, partner: 'ANTHROPIC* CLAUDE SUB', ext: '165074241|-85202' });
  });
});

import { suggestLeaf } from '../shared/match';
describe('kulcsszó alapú kategória', () => {
  const leaves = ['Bank költség', 'KIVA', 'Járulékok', 'Adó'].map((label, i) => ({ id: 'l' + i, group_id: 'g', label, sort: 0, archived: 0 }));
  const s = (partner: string) => suggestLeaf({ date: '2026-10-09', amount: -100, partner, memo: '' }, {}, leaves, () => 'out');
  it('banki díjak, KIVA, járulék', () => {
    expect(s('Tranzakciós díj')).toBe('l0');
    expect(s('Érkezett bankkártya díj terhelés')).toBe('l0');
    expect(s('Kisvállalati adó')).toBe('l1');
    expect(s('NAV TB járulék')).toBe('l2');
  });
});
