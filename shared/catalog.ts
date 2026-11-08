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
export const UNITS = ['db', 'hó', 'óra', 'nap', 'alkalom', 'csomag', 'projekt'];
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
}

export const PROFILE_FIELDS: [Exclude<keyof PartnerProfile, 'pay_days'>, string, number][] = [
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
export function billableIn(a: Pick<PartnerProduct, 'start_ym' | 'end_ym'>, billing: Billing, ym: string): boolean {
  if (!/^\d{4}-\d{2}$/.test(a.start_ym) || ym < a.start_ym) return false;
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
