-- Cashflow tervező – kezdeti séma

CREATE TABLE users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  name TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('admin','member','viewer')),
  pw_hash TEXT NOT NULL,
  pw_salt TEXT NOT NULL,
  pw_iter INTEGER NOT NULL,
  must_change_pw INTEGER NOT NULL DEFAULT 0,
  totp_secret TEXT,
  totp_enabled INTEGER NOT NULL DEFAULT 0,
  failed_logins INTEGER NOT NULL DEFAULT 0,
  locked_until INTEGER NOT NULL DEFAULT 0,
  disabled INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  last_login INTEGER
);

CREATE TABLE sessions (
  token_hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  last_seen INTEGER NOT NULL,
  ip TEXT,
  user_agent TEXT
);
CREATE INDEX idx_sessions_user ON sessions(user_id);

CREATE TABLE login_attempts (
  ip TEXT NOT NULL,
  ts INTEGER NOT NULL
);
CREATE INDEX idx_login_attempts ON login_attempts(ip, ts);

CREATE TABLE audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  user_id INTEGER,
  action TEXT NOT NULL,
  detail TEXT
);

-- Kategóriafa: szekció (in/out) → csoport → tétel-kategória (leaf)
CREATE TABLE groups (
  id TEXT PRIMARY KEY,
  section TEXT NOT NULL CHECK (section IN ('in','out')),
  label TEXT NOT NULL,
  sort INTEGER NOT NULL DEFAULT 0,
  UNIQUE(section, label)
);

CREATE TABLE leaves (
  id TEXT PRIMARY KEY,
  group_id TEXT NOT NULL REFERENCES groups(id),
  label TEXT NOT NULL,
  sort INTEGER NOT NULL DEFAULT 0,
  archived INTEGER NOT NULL DEFAULT 0,
  UNIQUE(group_id, label)
);

-- Ismétlődő sorozatok
CREATE TABLE series (
  id TEXT PRIMARY KEY,
  leaf_id TEXT NOT NULL REFERENCES leaves(id),
  name TEXT NOT NULL,
  rep TEXT NOT NULL DEFAULT 'once' CHECK (rep IN ('once','monthly','quarterly')),
  day INTEGER NOT NULL DEFAULT 10
);

-- Tételek: tény (actual) és terv (plan). Az összeg előjeles: + bevétel, − kiadás.
CREATE TABLE entries (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('actual','plan')),
  date TEXT NOT NULL,                       -- YYYY-MM-DD
  leaf_id TEXT NOT NULL REFERENCES leaves(id),
  name TEXT NOT NULL DEFAULT '',
  amount INTEGER NOT NULL,
  series_id TEXT,
  done INTEGER NOT NULL DEFAULT 0,          -- terv: teljesült / lezárt
  tentative INTEGER NOT NULL DEFAULT 0,     -- ajánlat (még nem biztos bevétel)
  source TEXT NOT NULL DEFAULT 'manual',    -- manual | import | billingo | bank
  ext_ref TEXT,                             -- pl. billingo:123, bank:<tx id>
  link_id TEXT,                             -- terv ↔ tény összekötés
  note TEXT,
  updated_at INTEGER NOT NULL,
  updated_by INTEGER
);
CREATE INDEX idx_entries_date ON entries(date);
CREATE INDEX idx_entries_leaf ON entries(leaf_id);
CREATE INDEX idx_entries_series ON entries(series_id);
CREATE UNIQUE INDEX idx_entries_ext ON entries(ext_ref) WHERE ext_ref IS NOT NULL;

-- Bankszámlák (PSD2 / Enable Banking vagy kézi CSV)
CREATE TABLE bank_accounts (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,                   -- enablebanking | manual
  bank_name TEXT NOT NULL,
  label TEXT NOT NULL,
  iban TEXT,
  currency TEXT NOT NULL DEFAULT 'HUF',
  balance INTEGER,
  balance_at INTEGER,
  eb_account_uid TEXT,
  eb_session_id TEXT,
  valid_until TEXT,
  last_sync INTEGER,
  last_error TEXT,
  active INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE bank_tx (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES bank_accounts(id),
  ext_id TEXT NOT NULL,
  date TEXT NOT NULL,
  amount INTEGER NOT NULL,
  currency TEXT NOT NULL DEFAULT 'HUF',
  partner TEXT NOT NULL DEFAULT '',
  memo TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'new' CHECK (status IN ('new','approved','ignored')),
  leaf_id TEXT,
  plan_id TEXT,
  actual_id TEXT,
  created_at INTEGER NOT NULL,
  UNIQUE(account_id, ext_id)
);
CREATE INDEX idx_bank_tx_status ON bank_tx(status);

-- Billingo számlák tükre
CREATE TABLE billingo_docs (
  id INTEGER PRIMARY KEY,
  number TEXT,
  partner TEXT,
  gross INTEGER NOT NULL,
  currency TEXT,
  invoice_date TEXT,
  due_date TEXT,
  payment_status TEXT,
  paid_date TEXT,
  cancelled INTEGER NOT NULL DEFAULT 0,
  plan_id TEXT,
  synced_at INTEGER NOT NULL
);

-- Tanult szabályok: partner név → kategória
CREATE TABLE partner_rules (
  pattern TEXT PRIMARY KEY,
  leaf_id TEXT NOT NULL,
  hits INTEGER NOT NULL DEFAULT 1,
  updated_at INTEGER NOT NULL
);

CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value TEXT
);

-- Enable Banking auth folyamat állapota (CSRF védelem)
CREATE TABLE oauth_states (
  state TEXT PRIMARY KEY,
  bank_name TEXT NOT NULL,
  user_id INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
