// Havidíj neve a hónappal: „Havi díj – 2026. október”. A hónap a díj saját hónapja (period), nem a fizetés napja –
// így ha egy havidíj fizetését máshova teszed, a neve (melyik hónapé) marad. A név átírható; a csoportosítás
// (egy sor a táblázatban, egy tétel az adatlapon) a hónap nélküli alapnév szerint megy.
import { monthLong, ymOf } from './model';

const MONTHS = 'január|február|március|április|május|június|július|augusztus|szeptember|október|november|december';
const SUFFIX = new RegExp(`\\s*(?:[–-]\\s*)?(\\d{4}\\.?\\s*)?(${MONTHS})\\s*$`, 'i');
/** havidíj jellegű név: „Havi díj”, „Havidíj”, „Havi díj (SEO)” … */
export const MONTHLY_RX = /^havi\s*d[ií]j\b/i;

/** a név a hónap nélkül („Havi díj – 2026. október” → „Havi díj”) */
export const baseName = (name: string) =>
  String(name || '')
    .replace(SUFFIX, '')
    .trim();
export const hasMonth = (name: string) => SUFFIX.test(String(name || ''));

/**
 * Ismétlődő (havi, negyedéves… ütemezésű) tételnél és havidíjnál a hónap a név végére, ha még nincs benne
 * (pl. „Munkabér – 2026. október”); egyszeri tételnél a név változatlan.
 */
export function withMonth(name: string, ym: string, recurring = false): string {
  const n = String(name || '').trim();
  if (!n || !(recurring || MONTHLY_RX.test(n)) || hasMonth(n) || /\d{4}\.\s*\p{L}/u.test(n) || !/^\d{4}-\d{2}$/.test(ym)) return name;
  return `${n} – ${monthLong(ym)}`;
}

/** a tétel hónapja: amelyikhez tartozik (period), különben a dátumé */
export const periodYm = (e: { period?: string | null; date: string }) => e.period || ymOf(e.date);
