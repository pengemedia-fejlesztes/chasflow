// Termék- és szolgáltatástörzs + partnerek számlázási adatai.
// A termék a számlázható tétel (pl. „Google Ads kezelés”, havi díj); a partnerhez rendelve (mennyiség, egyedi ár,
// kezdő és záró hónap) megadja, mit kell neki az adott hónapban kiszámlázni.
import { addMonths } from './model';

export type Billing = 'egyszeri' | 'havi' | 'negyedeves' | 'felevi' | 'eves';
export type ProductKind = 'szolgaltatas' | 'termek';
export type Vat = '27' | '18' | '5' | '0' | 'AAM' | 'TAM' | 'EUFAD37' | 'FAD';

export const BILLINGS: [Billing, string][] = [
  ['havi', 'Havonta'],
  ['negyedeves', 'Negyedévente'],
  ['felevi', 'Félévente'],
  ['eves', 'Évente'],
  ['egyszeri', 'Egyszeri'],
];
export const BILLING_LABEL = Object.fromEntries(BILLINGS) as Record<Billing, string>;
export const BILLING_STEP: Record<Billing, number> = { egyszeri: 0, havi: 1, negyedeves: 3, felevi: 6, eves: 12 };

export const VATS: [Vat, string][] = [
  ['27', '27%'],
  ['18', '18%'],
  ['5', '5%'],
  ['0', '0%'],
  ['AAM', 'AAM (alanyi mentes)'],
  ['TAM', 'TAM (tárgyi mentes)'],
  ['EUFAD37', 'EU fordított adózás'],
  ['FAD', 'Fordított adózás'],
];
export const UNITS = ['db', 'hó', 'óra', 'nap', 'év', 'alkalom', 'csomag', 'projekt'];
export const CURRENCIES = ['HUF', 'EUR', 'USD'];

export interface Product {
  id: string;
  name: string;
  kind: ProductKind;
  unit: string;
  /** nettó egységár */
  price: number;
  vat: Vat;
  currency: string;
  billing: Billing;
  /** cikkszám / belső kód */
  sku: string | null;
  note: string | null;
  /** termékcsoport (pl. Késztermékek, Szolgáltatások) */
  grp?: string | null;
  /** telefonos emlékeztető ennyi nappal a számlázás előtt (null: nincs) */
  call_days?: number | null;
  archived: number;
  updated_at: number;
}

/** partnerhez rendelt termék / szolgáltatás */
export interface PartnerProduct {
  id: string;
  partner_key: string;
  product_id: string;
  qty: number;
  /** egyedi nettó egységár (null: a törzs szerinti ár) */
  price: number | null;
  /** egyedi számlázási ütem (null: a törzs szerinti) */
  billing: Billing | null;
  start_ym: string;
  end_ym: string | null;
  note: string | null;
  /** kihagyott számlázási hónapok (YYYY-MM) – a havi rácson kattintással */
  skip?: string[];
  /** 1 = a megjegyzés belső, nem kerül a számlára */
  note_internal?: number;
  updated_at: number;
}

/** a partner számlázási adatai (a partnertörzs kiegészítése) */
export interface PartnerProfile {
  company: string;
  zip: string;
  city: string;
  address: string;
  country: string;
  email: string;
  billing_email: string;
  phone: string;
  contact: string;
  eu_tax: string;
  /** fizetési határidő napokban (számla kelte + N nap) */
  pay_days: number | null;
  bank_account: string;
  website: string;
  /** további kapcsolattartók */
  contacts: PartnerContact[];
  /** a partnerért felelős / őt követő felhasználók */
  followers: number[];
  /** egyéni mezők (pl. beosztás, érdeklődési kör) */
  custom: { label: string; value: string }[];
}

export interface PartnerContact {
  name: string;
  role: string;
  email: string;
  phone: string;
}

export const PROFILE_FIELDS: [Exclude<keyof PartnerProfile, 'pay_days' | 'contacts' | 'followers' | 'custom'>, string, number][] = [
  ['company', 'Hivatalos cégnév', 160],
  ['zip', 'Irányítószám', 12],
  ['city', 'Település', 80],
  ['address', 'Utca, házszám', 160],
  ['country', 'Ország', 60],
  ['email', 'E-mail', 160],
  ['billing_email', 'Számlázási e-mail', 160],
  ['phone', 'Telefon', 40],
  ['contact', 'Kapcsolattartó', 120],
  ['eu_tax', 'Közösségi adószám', 20],
  ['bank_account', 'Bankszámlaszám', 40],
  ['website', 'Weboldal', 160],
];

export function emptyProfile(): PartnerProfile {
  return {
    company: '',
    zip: '',
    city: '',
    address: '',
    country: 'Magyarország',
    email: '',
    billing_email: '',
    phone: '',
    contact: '',
    eu_tax: '',
    pay_days: null,
    bank_account: '',
    website: '',
    contacts: [],
    followers: [],
    custom: [],
  };
}

/** a beküldött számlázási adatok tisztítása (ismeretlen mező kimarad, hossz-korlát) */
export function cleanProfile(v: unknown): PartnerProfile {
  const src = (v && typeof v === 'object' ? v : {}) as Record<string, unknown>;
  const out = emptyProfile();
  for (const [k, , max] of PROFILE_FIELDS) {
    if (src[k] === undefined) continue;
    out[k] = String(src[k] ?? '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, max);
  }
  const str = (x: unknown, max: number) =>
    String(x ?? '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, max);
  if (Array.isArray(src.contacts))
    out.contacts = src.contacts
      .filter((c) => c && typeof c === 'object')
      .map((c: any) => ({ name: str(c.name, 120), role: str(c.role, 80), email: str(c.email, 160), phone: str(c.phone, 40) }))
      .filter((c) => c.name || c.email || c.phone)
      .slice(0, 30);
  if (Array.isArray(src.followers))
    out.followers = [...new Set(src.followers.map(Number).filter((n) => Number.isInteger(n) && n > 0))].slice(0, 30);
  if (Array.isArray(src.custom))
    out.custom = src.custom
      .filter((c) => c && typeof c === 'object')
      .map((c: any) => ({ label: str(c.label, 60), value: str(c.value, 300) }))
      .filter((c) => c.label)
      .slice(0, 40);
  const d = Number(src.pay_days);
  out.pay_days =
    src.pay_days === null || src.pay_days === '' || src.pay_days === undefined || !Number.isFinite(d) ? null : Math.max(0, Math.min(365, Math.round(d)));
  return out;
}

/** a partner-termék tényleges ára és ütemezése (az egyedi érték, különben a törzsé) */
export function effective(a: PartnerProduct, p: Product | undefined) {
  const price = a.price ?? p?.price ?? 0;
  const billing = a.billing ?? p?.billing ?? 'havi';
  const net = Math.round(price * a.qty);
  return { price, billing, net, gross: grossOf(net, p?.vat || '27') };
}

export function vatRate(v: string): number {
  const n = Number(v);
  return Number.isFinite(n) ? n / 100 : 0;
}

export function grossOf(net: number, vat: string): number {
  return Math.round(net * (1 + vatRate(vat)));
}

/** számlázandó-e a hozzárendelés az adott hónapban (ütem, kezdő és záró hónap alapján) */
export function billableIn(a: Pick<PartnerProduct, 'start_ym' | 'end_ym'> & { skip?: string[] }, billing: Billing, ym: string): boolean {
  if (!/^\d{4}-\d{2}$/.test(a.start_ym) || ym < a.start_ym) return false;
  if (a.skip?.includes(ym)) return false;
  if (a.end_ym && ym > a.end_ym) return false;
  const step = BILLING_STEP[billing];
  if (!step) return ym === a.start_ym;
  const [y0, m0] = a.start_ym.split('-').map(Number);
  const [y1, m1] = ym.split('-').map(Number);
  return ((y1 - y0) * 12 + (m1 - m0)) % step === 0;
}

/** egy hónapra eső havi átlagérték (nettó): ütem szerint elosztva, az egyszeri nem számít bele */
export function monthlyValue(net: number, billing: Billing): number {
  const step = BILLING_STEP[billing];
  return step ? Math.round(net / step) : 0;
}

export interface BillLine {
  assign: PartnerProduct;
  product: Product | undefined;
  net: number;
  gross: number;
  billing: Billing;
}

/** az adott hónapban kiszámlázandó tételek (minden partnerre, vagy egy partnerre szűrve) */
export function billablesFor(ym: string, assigns: PartnerProduct[], products: Product[], partnerKey?: string): BillLine[] {
  const byId = new Map(products.map((p) => [p.id, p]));
  const out: BillLine[] = [];
  for (const a of assigns) {
    if (partnerKey && a.partner_key !== partnerKey) continue;
    const p = byId.get(a.product_id);
    const e = effective(a, p);
    if (billableIn(a, e.billing, ym)) out.push({ assign: a, product: p, net: e.net, gross: e.gross, billing: e.billing });
  }
  return out;
}

/** a következő számlázási hónap (ym-től kezdve), vagy null ha már nincs */
export function nextBilling(a: PartnerProduct, billing: Billing, from: string): string | null {
  let ym = from < a.start_ym ? a.start_ym : from;
  for (let i = 0; i < 24; i++, ym = addMonths(ym, 1)) {
    if (a.end_ym && ym > a.end_ym) return null;
    if (billableIn(a, billing, ym)) return ym;
  }
  return null;
}

// ── a partnereknél felvitt tételekből (tervek) a termék- és szolgáltatástörzs feltöltése ──

export interface DeriveLeaf {
  id: string;
  label: string;
  section: 'in' | 'out';
  /** ajánlat-csoportba tartozik (nem biztos megrendelés) */
  offer: boolean;
}
export interface DerivePlan {
  leaf_id: string;
  name: string;
  amount: number;
  date: string;
  period?: string | null;
  series_id?: string | null;
  tentative?: number | null;
}
export interface DerivedAssign {
  partner_key: string;
  name: string;
  qty: number;
  /** nettó egységár */
  price: number;
  billing: Billing;
  start_ym: string;
  end_ym: string | null;
  offer: boolean;
}
export interface DerivedProduct {
  name: string;
  price: number;
  billing: Billing;
}

const REP_BILLING: Record<string, Billing> = { monthly: 'havi', quarterly: 'negyedeves', yearly: 'eves', once: 'egyszeri' };
const norm = (s: string) =>
  String(s || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
const MONTH_SUFFIX = /\s*[–-]\s*\d{4}\.\s*\p{L}+\.?\s*$/u;

/** a terv nevéből a termék neve: hónap, partnernév-előtag, részlet-/előleg-utótag nélkül; számlaszámnál null */
export function productNameOf(name: string, partner: string): string | null {
  let n = String(name || '')
    .replace(MONTH_SUFFIX, '')
    .replace(/\s+/g, ' ')
    .trim();
  const p = norm(partner);
  const m = n.match(/^(.+?)\s*[-–:]\s+(.+)$/);
  if (m && p && norm(m[1]) === p) n = m[2].trim();
  n = n
    .replace(/\s*[-–]\s*\d+\.?\s*(r[ée]szlet|r[ée]sz)\s*$/i, '')
    .replace(/\s*[-–]\s*(el[őo]leg|[áa]tad[áa]s|v[ée]gsz[áa]mla)\s*$/i, '')
    .trim();
  if (n.length < 2 || /\d{4}-\d{5,}/.test(n) || norm(n) === p) return null;
  return n.charAt(0).toUpperCase() + n.slice(1);
}

export const netOf = (gross: number) => Math.round(Math.abs(gross) / 1.27);

/**
 * A bevételi oldalon felvitt tervekből (a folyó hónap előtti 2 hónaptól) partnerenként a számlázott termékek:
 * ismétlődő sorozat → az ütemének megfelelő számlázás, a havonta többször szereplő azonos tétel → mennyiség;
 * egyszeri (akár részletekben) → egy tétel a részletek összegével.
 */
export function deriveCatalog(
  leaves: DeriveLeaf[],
  plans: DerivePlan[],
  seriesRep: Record<string, string>,
  cur: string,
  partnerKeyOf: (label: string) => string,
): { products: DerivedProduct[]; assigns: DerivedAssign[] } {
  const leafById = new Map(leaves.filter((l) => l.section === 'in').map((l) => [l.id, l]));
  const since = addMonths(cur, -2);
  type G = { partner: string; name: string; offer: boolean; months: Map<string, number[]>; reps: Set<string> };
  const groups = new Map<string, G>();
  for (const e of plans) {
    const l = leafById.get(e.leaf_id);
    if (!l || !e.amount) continue;
    const ym = e.period || e.date.slice(0, 7);
    if (ym < since) continue;
    const name = productNameOf(e.name, l.label);
    if (!name) continue;
    const pk = partnerKeyOf(l.label);
    const k = pk + '|' + norm(name);
    const g = groups.get(k) || { partner: pk, name, offer: true, months: new Map(), reps: new Set() };
    g.offer = g.offer && (l.offer || !!e.tentative);
    g.months.set(ym, [...(g.months.get(ym) || []), Math.abs(e.amount)]);
    if (e.series_id && seriesRep[e.series_id]) g.reps.add(seriesRep[e.series_id]);
    groups.set(k, g);
  }
  const assigns: DerivedAssign[] = [];
  for (const g of groups.values()) {
    const months = [...g.months.keys()].sort();
    const rep = [...g.reps].find((r) => r !== 'once');
    const recurring = !!rep || /^havi\s*d[ií]j/i.test(g.name) || months.length >= 3;
    if (recurring) {
      // a legközelebbi (vagy utolsó) hónap tételei: darabszám és egységár
      const ref = months.find((m) => m >= cur) || months[months.length - 1];
      const amts = g.months.get(ref)!;
      const unit = Math.max(...amts);
      const qty = amts.filter((a) => a === unit).length === amts.length ? amts.length : 1;
      const price = qty > 1 ? netOf(unit) : netOf(amts.reduce((s, a) => s + a, 0));
      const last = months[months.length - 1];
      assigns.push({
        partner_key: g.partner,
        name: g.name,
        qty,
        price,
        billing: rep ? REP_BILLING[rep] : 'havi',
        start_ym: months[0],
        end_ym: last >= addMonths(cur, 11) ? null : last,
        offer: g.offer,
      });
    } else {
      const total = [...g.months.values()].flat().reduce((s, a) => s + a, 0);
      assigns.push({
        partner_key: g.partner,
        name: g.name,
        qty: 1,
        price: netOf(total),
        billing: 'egyszeri',
        start_ym: months[0],
        end_ym: null,
        offer: g.offer,
      });
    }
  }
  // termék: a nevek szerint összevonva; ár és ütem a leggyakoribb a partnerek között
  const byName = new Map<string, DerivedAssign[]>();
  for (const a of assigns) byName.set(norm(a.name), [...(byName.get(norm(a.name)) || []), a]);
  const mode = <T>(xs: T[]) => {
    const c = new Map<T, number>();
    xs.forEach((x) => c.set(x, (c.get(x) || 0) + 1));
    return [...c.entries()].sort((a, b) => b[1] - a[1])[0][0];
  };
  const products = [...byName.values()].map((as) => ({ name: as[0].name, price: mode(as.map((a) => a.price)), billing: mode(as.map((a) => a.billing)) }));
  return { products: products.sort((a, b) => a.name.localeCompare(b.name, 'hu')), assigns };
}
