// Kategória-szövegek és importsorok értelmezése (a TÉNYEK / TERVEK xls formátuma).
import type { Section } from './types';

/** Rövid, determinisztikus hash (FNV-1a 32 bit, hex). */
export function hash(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

export function normalizeText(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

export const groupId = (section: Section, label: string) => 'g_' + hash(section + '|' + normalizeText(label));
export const leafId = (gid: string, label: string) => 'l_' + hash(gid + '|' + normalizeText(label));

/** "1 Munkatársak jövedelmei" → "1 · Munkatársak jövedelmei" */
export function displayGroup(label: string): string {
  return label.replace(/^(\d+)\s+/, '$1 · ');
}

/** Csoport sorrend: a számozott kiadás-csoportok a számuk szerint. */
export function groupSortKey(label: string): number {
  const m = label.match(/^(\d+)/);
  if (m) return parseInt(m[1], 10) * 10;
  if (/aj[aá]nlat/i.test(label)) return 1;
  return 5;
}

export interface ParsedCategory {
  section: Section;
  group: string;
  leaf: string;
}

/**
 * Kategória szöveg felbontása.
 *  "3 Működési költségek - Szoftver, beszerzés" → out / "3 Működési költségek" / "Szoftver, beszerzés"
 *  "1 - Ajánlatok - Alvállalkozói ajánlatok"     → out / "1 Ajánlatok" / "Alvállalkozói ajánlatok"
 *  "Projektek - Alfa"                         → in  / "Projektek" / "Alfa"
 *  "Ajánlatok"                                    → in  / "Ajánlatok" / (a tétel nevéből)
 */
export function parseCategory(raw: string, itemName = ''): ParsedCategory {
  let s = (raw || '').trim().replace(/\s+/g, ' ');
  s = s.replace(/^(\d+)\s*-\s*/, '$1 ');
  const idx = s.indexOf(' - ');
  let group = idx >= 0 ? s.slice(0, idx).trim() : s;
  let leaf = idx >= 0 ? s.slice(idx + 3).trim() : '';
  if (!group) group = 'Egyéb';
  const section: Section = /^\d/.test(group) ? 'out' : 'in';
  if (!leaf) {
    leaf = section === 'in' && /aj[aá]nlat/i.test(group) ? offerLeaf(itemName) : 'Egyéb';
  }
  // "5 Penge Bővítés" és "5 Penge bővítés" ugyanaz legyen
  group = group.replace(/\s+/g, ' ');
  return { section, group, leaf };
}

/** "GAMMA-SEO-448.000" → 448000 ; "Minta Ügyfél - setup-762.000" → 762000 */
export function offerAmount(name: string): number {
  const m = (name || '').match(/(\d{1,3}(?:[.\s]\d{3})+|\d{4,})\s*(?:ft)?\s*$/i);
  if (!m) return 0;
  return parseInt(m[1].replace(/[.\s]/g, ''), 10) || 0;
}

/** Az ajánlat ügyfélneve: az első kötőjel előtti rész. */
export function offerLeaf(name: string): string {
  const base = (name || '').replace(/-?\s*(\d{1,3}(?:[.\s]\d{3})+|\d{4,})\s*(?:ft)?\s*$/i, '').trim();
  const first = base.split(/\s*-\s*/)[0].trim();
  return first || 'Egyéb ajánlat';
}

export function offerName(name: string): string {
  return (name || '').replace(/-?\s*(\d{1,3}(?:[.\s]\d{3})+|\d{4,})\s*(?:ft)?\s*$/i, '').trim() || name;
}

/** "2026. 10. 01." / "2026-10-01" / Excel dátumszám → "2026-10-01" */
export function parseDate(v: unknown): string | null {
  if (typeof v === 'number' && isFinite(v)) {
    // Excel sorszám (1900-as rendszer)
    const ms = Math.round((v - 25569) * 86400000);
    return new Date(ms).toISOString().slice(0, 10);
  }
  const s = String(v ?? '').trim();
  const m = s.match(/^(\d{4})[.\-/]\s*(\d{1,2})[.\-/]\s*(\d{1,2})/);
  if (!m) return null;
  return `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
}

export function parseAmount(v: unknown): number {
  if (typeof v === 'number') return Math.round(v);
  const s = String(v ?? '')
    .replace(/\s/g, '')
    .replace(/Ft$/i, '');
  if (!s) return 0;
  // magyar formátum: 1.234.567,89 vagy 1 234 567
  const norm = s.includes(',') ? s.replace(/\./g, '').replace(',', '.') : s.replace(/\.(?=\d{3}(\D|$))/g, '');
  const n = parseFloat(norm);
  return isFinite(n) ? Math.round(n) : 0;
}

export interface ImportRow {
  date: string;
  name: string;
  category: string;
  amount: number;
}

export interface NormalizedImport {
  section: Section;
  group: string;
  leaf: string;
  date: string;
  name: string;
  amount: number;
  tentative: boolean;
}

/** Egy xls sor normalizálása. null = kihagyandó (pl. 0 Ft-os tény). */
export function normalizeImportRow(r: ImportRow, kind: 'actual' | 'plan'): NormalizedImport | null {
  const date = parseDate(r.date);
  if (!date) return null;
  const cat = parseCategory(r.category, r.name);
  let amount = Math.round(r.amount || 0);
  let name = (r.name || '').trim();
  let tentative = false;
  const isOffer = cat.section === 'in' && /aj[aá]nlat/i.test(cat.group);
  if (isOffer && amount === 0) {
    amount = offerAmount(name);
    name = offerName(name);
    tentative = true;
    if (kind === 'actual') return null; // régi ajánlat-jegyzetek: nem pénzmozgás
  }
  if (amount === 0) return null;
  // Az előjelet az xls adja; ha hiányzik, a szekció szerint pótoljuk.
  if (tentative) amount = Math.abs(amount);
  return { ...cat, date, name: name || cat.leaf, amount, tentative };
}
