// Táblázat (xlsx / csv) → sorok, védett módon: a munkalap deklarált tartománya (!ref) nem hihető el –
// egy apró fájl is jelezhet milliós tartományt, amin a sheet_to_json percekig futna. Ezért a valódi cellákból
// számoljuk a tartományt, és korlátozzuk a sorok, oszlopok és cellák számát. (A Web Worker hívja, de tesztelhető önállóan is.)
import type * as XLSXNS from 'xlsx';

export const SHEET_LIMITS = { maxBytes: 10 * 1024 * 1024, maxRows: 20000, maxCols: 60, maxCells: 300000 };

export type SheetInput = { kind: 'array'; buf: ArrayBuffer; raw?: boolean } | { kind: 'csv'; text: string; FS: string };

export function sheetRows(XLSX: typeof XLSXNS, input: SheetInput, limits = SHEET_LIMITS): any[][] {
  const size = input.kind === 'array' ? input.buf.byteLength : input.text.length;
  if (size > limits.maxBytes) throw new Error(`Túl nagy fájl (legfeljebb ${Math.round(limits.maxBytes / 1048576)} MB).`);
  const opts = { sheetRows: limits.maxRows + 1, cellFormula: false, cellHTML: false, cellStyles: false, bookVBA: false } as const;
  const wb =
    input.kind === 'csv'
      ? XLSX.read(input.text, { ...opts, type: 'string', FS: input.FS, raw: true })
      : XLSX.read(input.buf, { ...opts, type: 'array', raw: input.raw ?? true, cellDates: false });
  const ws = wb.Sheets[wb.SheetNames[0]];
  if (!ws) throw new Error('Üres munkafüzet.');
  return rowsOfSheet(XLSX, ws, limits);
}

/** A munkalap sorai a valódi cellák tartományán (a deklarált !ref figyelmen kívül), korlátokkal. */
export function rowsOfSheet(XLSX: typeof XLSXNS, ws: XLSXNS.WorkSheet, limits = SHEET_LIMITS): any[][] {
  // valódi tartomány a ténylegesen meglévő cellákból
  let cells = 0;
  let maxR = -1;
  let maxC = -1;
  for (const k of Object.keys(ws)) {
    if (k[0] === '!') continue;
    if (++cells > limits.maxCells) throw new Error(`Túl sok cella a munkalapon (legfeljebb ${limits.maxCells.toLocaleString('hu-HU')}).`);
    const a = XLSX.utils.decode_cell(k);
    if (a.r > maxR) maxR = a.r;
    if (a.c > maxC) maxC = a.c;
  }
  if (maxR < 0) return [];
  if (maxR + 1 > limits.maxRows) throw new Error(`Túl sok sor (legfeljebb ${limits.maxRows.toLocaleString('hu-HU')}).`);
  if (maxC + 1 > limits.maxCols) throw new Error(`Túl sok oszlop (legfeljebb ${limits.maxCols}).`);
  ws['!ref'] = XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: maxR, c: maxC } });
  return XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, defval: '' });
}
