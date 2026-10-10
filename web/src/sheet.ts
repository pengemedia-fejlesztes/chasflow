// Importfájl beolvasása Web Workerben, időkorláttal (túllépésnél a worker leáll, a felület nem fagy le).
import { SHEET_LIMITS, type SheetInput } from './sheetCore';

export const SHEET_TIMEOUT_MS = 15000;

export function readSheetRows(input: SheetInput, timeoutMs = SHEET_TIMEOUT_MS): Promise<any[][]> {
  const size = input.kind === 'array' ? input.buf.byteLength : input.text.length;
  if (size > SHEET_LIMITS.maxBytes) return Promise.reject(new Error(`Túl nagy fájl (legfeljebb ${Math.round(SHEET_LIMITS.maxBytes / 1048576)} MB).`));
  return new Promise((resolve, reject) => {
    const w = new Worker(new URL('./sheetWorker.ts', import.meta.url), { type: 'module' });
    const timer = setTimeout(() => {
      w.terminate();
      reject(new Error('Az importfájl feldolgozása túl sokáig tartott – megszakítva. Ellenőrizd a fájlt.'));
    }, timeoutMs);
    w.onmessage = (ev: MessageEvent<{ rows?: any[][]; error?: string }>) => {
      clearTimeout(timer);
      w.terminate();
      if (ev.data.error) reject(new Error(ev.data.error));
      else resolve(ev.data.rows || []);
    };
    w.onerror = (ev) => {
      clearTimeout(timer);
      w.terminate();
      reject(new Error('Az importfájl nem olvasható: ' + (ev.message || 'ismeretlen hiba')));
    };
    // az ArrayBuffer átadása másolás nélkül
    w.postMessage(input, input.kind === 'array' ? [input.buf] : []);
  });
}
