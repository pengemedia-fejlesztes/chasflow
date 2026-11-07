// Web Worker: a táblázat feldolgozása a főszálon kívül (a felület nem akad meg; a hívó időkorláttal leállíthatja).
import * as XLSX from 'xlsx';
import { sheetRows, type SheetInput } from './sheetCore';

self.onmessage = (ev: MessageEvent<SheetInput>) => {
  try {
    (self as unknown as Worker).postMessage({ rows: sheetRows(XLSX, ev.data) });
  } catch (e: any) {
    (self as unknown as Worker).postMessage({ error: String(e?.message || e) });
  }
};
