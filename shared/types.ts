// Közös típusok a Worker (API) és a webes felület között.

export type Section = 'in' | 'out';
export type Role = 'admin' | 'member' | 'viewer';
export type Rep = 'once' | 'monthly' | 'quarterly' | 'yearly';

export interface Group {
  id: string;
  section: Section;
  label: string;
  sort: number;
  pay_rule?: string | null;
}

export interface Leaf {
  id: string;
  group_id: string;
  label: string;
  sort: number;
  archived: number;
  pay_rule?: string | null;
  /** partner általános fizetési határideje (nap, a számla kiállításától) */
  pay_days?: number | null;
}

/** Partnertörzs: a partner adatlapjának szerkeszthető adatai (a kulcs a partner normalizált neve). */
export interface Partner {
  key: string;
  name: string;
  kind: 'vevo' | 'szallito' | 'mindketto' | null;
  /** alternatív nevek: cégnév, Billingo-számlanév, banki név, üzlet/kút neve… – ezek alapján párosít és összevon */
  aliases: string[];
  tax_number: string | null;
  note: string | null;
  updated_at: number;
}

export interface Series {
  id: string;
  leaf_id: string;
  name: string;
  rep: Rep;
  day: number;
}

export interface Entry {
  id: string;
  kind: 'actual' | 'plan';
  date: string; // YYYY-MM-DD
  leaf_id: string;
  name: string;
  /** Előjeles összeg Ft-ban: + bevétel, − kiadás */
  amount: number;
  series_id: string | null;
  done: number;
  tentative: number;
  /** 1 = valaha ajánlat volt (megnyert ajánlat követéséhez) */
  was_offer?: number;
  /** mikor lett ajánlatként felvéve / mikor fogadták el (ms) */
  offer_at?: number | null;
  accepted_at?: number | null;
  /** számlához kötött terv eredeti (tervezett) összege – alulszámlázás figyeléséhez */
  plan_amount?: number | null;
  /** a tervhez kötött Billingo-számla bruttó összege (a terv összege ettől nem változik) */
  bill_amount?: number | null;
  /** a hónap (YYYY-MM), amelyhez a tétel tartozik (pl. az októberi havidíj), ha később számlázzuk / fizetik; üres = a fizetés hónapja */
  period?: string | null;
  source: string;
  ext_ref: string | null;
  link_id: string | null;
  note: string | null;
  updated_at?: number;
}

export interface BankAccount {
  id: string;
  provider: string;
  bank_name: string;
  label: string;
  iban: string | null;
  currency: string;
  balance: number | null;
  balance_at: number | null;
  valid_until: string | null;
  last_sync: number | null;
  last_error: string | null;
  active: number;
}

export interface BankTx {
  id: string;
  account_id: string;
  date: string;
  amount: number;
  currency: string;
  partner: string;
  memo: string;
  status: 'new' | 'approved' | 'ignored';
  leaf_id: string | null;
  plan_id: string | null;
  actual_id: string | null;
}

export interface BillingoDoc {
  id: number;
  number: string | null;
  partner: string | null;
  partner_tax?: string | null;
  gross: number;
  currency: string | null;
  invoice_date: string | null;
  due_date: string | null;
  payment_status: string | null;
  paid_date: string | null;
  cancelled: number;
  plan_id: string | null;
}

export interface NavInvoice {
  id: string;
  invoice_number: string;
  operation: string | null;
  partner_tax: string | null;
  partner_name: string;
  issue_date: string | null;
  payment_date: string | null;
  payment_method: string | null;
  /** bruttó Ft, előjeles (bejövő számla = negatív) */
  gross: number;
  leaf_id: string | null;
  plan_id: string | null;
  actual_id: string | null;
  /** new = nincs hozzá terv; planned = tervhez kötve; paid = banki tény már van; ignored = nem kell terv */
  status: 'new' | 'planned' | 'paid' | 'ignored';
  created_at: number;
}

export interface Me {
  id: number;
  email: string;
  name: string;
  role: Role;
  totp_enabled: number;
  must_change_pw: number;
}

export interface Settings {
  opening_balance?: string; // nyitó egyenleg a legelső tény előtt
  billingo_last_sync?: string;
  billingo_autopay_last?: string;
  billingo_leaf_default?: string;
  bank_last_sync?: string;
  nav_last_sync?: string;
  nav_last_error?: string;
  flags_ack?: string; // „rendben” jelölt riasztások (JSON lista)
  profit_target?: string; // havi eredmény-cél (Ft)
  default_pay_days?: string; // alapértelmezett fizetési határidő (nap a számlától), ha a partnernél nincs megadva
  default_oneoff_days?: string; // egyszeri tétel várható fizetése: felviteltől N nap
  default_pay_days_in?: string; // vevőknek (bevétel) – ha üres, a közös érték
  default_pay_days_out?: string; // szállítóknak (kiadás)
  default_oneoff_days_in?: string;
  default_oneoff_days_out?: string;
}

export interface DataBundle {
  me: Me;
  today: string;
  groups: Group[];
  leaves: Leaf[];
  series: Series[];
  entries: Entry[];
  accounts: BankAccount[];
  bankTx: BankTx[];
  billingo: BillingoDoc[];
  settings: Settings;
  integrations: { billingo: boolean; enableBanking: boolean; nav?: boolean };
  /** törölt (kukában lévő) tervek az elmúlt 2 hónaptól – áthúzva látszanak, visszaállíthatók */
  deleted?: DeletedEntry[];
  /** havi terv–tény pillanatképek (lezárt hónapok + folyó hónap) */
  monthStats?: import('./planactual').MonthStat[];
  /** banki (számlázási) partnernevek kategóriánként */
  partnerNames?: { leaf_id: string; partner: string; n: number; last: string }[];
  /** NAV Online Számla: bejövő (szállítói) számlák */
  navInvoices?: NavInvoice[];
  /** elutasított (lezárt, nem elfogadott) ajánlatok */
  lostOffers?: LostOffer[];
  /** partnertörzs */
  partners?: Partner[];
  /** munkatársak és ledolgozott idejük (fedezeti pont) */
  employees?: import('./worktime').Employee[];
  worktime?: import('./worktime').WorktimeRow[];
}

export interface LostOffer {
  id: string;
  name: string;
  leaf_id: string;
  amount: number;
  date: string;
  series_id?: string | null;
  deleted_at: number;
  offer_at?: number | null;
}

export interface DeletedEntry extends Entry {
  rid: number;
  deleted_at: number;
}

export interface EntryBatch {
  /** Required by the API: previous entry version, null only for a new/absent ID. */
  expected?: Record<string, number | null>;
  /** Previous series fields serialized as [leaf_id, name, rep, day], null for a new ID. */
  expectedSeries?: Record<string, string | null>;
  upsert?: Entry[];
  delete?: string[];
  series?: Series[];
  deleteSeries?: string[];
  /** visszavonás: a saját, épp most létrehozott tételek kuka nélkül törlődnek */
  purge?: boolean;
  /** a törölt tételek elutasított ajánlatok (beszámítanak az elfogadási arányba) */
  rejected?: boolean;
  /** a változásnaplóba kerülő rövid leírás (a felhasználónak mutatott üzenet) */
  label?: string;
}
