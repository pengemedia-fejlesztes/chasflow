// Közös típusok a Worker (API) és a webes felület között.

export type Section = 'in' | 'out';
export type Role = 'admin' | 'member' | 'viewer';
export type Rep = 'once' | 'monthly' | 'quarterly';

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
  gross: number;
  currency: string | null;
  invoice_date: string | null;
  due_date: string | null;
  payment_status: string | null;
  paid_date: string | null;
  cancelled: number;
  plan_id: string | null;
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
  billingo_leaf_default?: string;
  bank_last_sync?: string;
  flags_ack?: string; // „rendben” jelölt riasztások (JSON lista)
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
  integrations: { billingo: boolean; enableBanking: boolean };
}

export interface EntryBatch {
  upsert?: Entry[];
  delete?: string[];
  series?: Series[];
  deleteSeries?: string[];
}
