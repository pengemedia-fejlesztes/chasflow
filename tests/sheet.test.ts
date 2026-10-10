import { describe, expect, it } from 'vitest';
import * as XLSX from 'xlsx';
import { rowsOfSheet, sheetRows } from '../web/src/sheetCore';

const book = (aoa: any[][], ref?: string) => {
  const ws = XLSX.utils.aoa_to_sheet(aoa);
  if (ref) ws['!ref'] = ref;
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'A');
  return XLSX.write(wb, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer;
};

describe('védett táblázat-beolvasás', () => {
  it('a túlméretezett deklarált tartományt a valódi cellákra szűkíti (gyors)', () => {
    const ws = XLSX.utils.aoa_to_sheet([
      ['Dátum', 'Összeg'],
      ['2026-10-01', 1000],
    ]);
    ws['!ref'] = 'A1:XFD1048576';
    const t = Date.now();
    const rows = rowsOfSheet(XLSX, ws);
    expect(Date.now() - t).toBeLessThan(1000);
    expect(rows).toEqual([
      ['Dátum', 'Összeg'],
      ['2026-10-01', 1000],
    ]);
  });
  it('túl sok oszlop / cella → hiba', () => {
    const wide = book([Array.from({ length: 80 }, (_, i) => i)]);
    expect(() => sheetRows(XLSX, { kind: 'array', buf: wide })).toThrow(/oszlop/);
    const many = book(Array.from({ length: 50 }, () => Array.from({ length: 10 }, () => 1)));
    expect(() => sheetRows(XLSX, { kind: 'array', buf: many }, { maxBytes: 1e7, maxRows: 1000, maxCols: 60, maxCells: 100 })).toThrow(/cella/);
  });
  it('csv pontosvesszővel', () => {
    expect(sheetRows(XLSX, { kind: 'csv', text: 'a;b\n1;2', FS: ';' })).toEqual([
      ['a', 'b'],
      ['1', '2'],
    ]);
  });
});
