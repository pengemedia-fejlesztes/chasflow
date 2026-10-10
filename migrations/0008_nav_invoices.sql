-- NAV Online Számla: bejövő (szállítói) számlák. Ha nincs hozzá terv, riasztás + javaslat (rendszeres / előre nem látható).
CREATE TABLE IF NOT EXISTS nav_invoices (
  id TEXT PRIMARY KEY,               -- nav:<szállító adószám>:<számlaszám>
  direction TEXT NOT NULL,           -- INBOUND
  invoice_number TEXT NOT NULL,
  operation TEXT,                    -- CREATE / MODIFY / STORNO
  partner_tax TEXT,
  partner_name TEXT,
  issue_date TEXT,
  delivery_date TEXT,
  payment_date TEXT,                 -- fizetési határidő
  payment_method TEXT,
  currency TEXT,
  gross INTEGER NOT NULL,            -- bruttó Ft, előjeles (bejövő = negatív)
  net INTEGER,
  leaf_id TEXT,                      -- javasolt kategória
  plan_id TEXT,                      -- a hozzá tartozó terv (ha van)
  actual_id TEXT,                    -- már kifizetett (banki tény)
  status TEXT NOT NULL DEFAULT 'new',-- new = terv nélkül, planned, paid, ignored
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS nav_invoices_status ON nav_invoices(status);
CREATE INDEX IF NOT EXISTS nav_invoices_issue ON nav_invoices(issue_date);
