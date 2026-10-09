-- Törölt tételek (kuka): a felhasználó által törölt tervek, ajánlatok, tények visszakereshetők és visszaállíthatók
CREATE TABLE deleted_entries (
  id TEXT NOT NULL,
  kind TEXT NOT NULL,
  date TEXT NOT NULL,
  leaf_id TEXT NOT NULL,
  name TEXT NOT NULL DEFAULT '',
  amount INTEGER NOT NULL,
  series_id TEXT,
  done INTEGER NOT NULL DEFAULT 0,
  tentative INTEGER NOT NULL DEFAULT 0,
  source TEXT NOT NULL DEFAULT 'manual',
  ext_ref TEXT,
  link_id TEXT,
  note TEXT,
  updated_at INTEGER,
  updated_by INTEGER,
  deleted_at INTEGER NOT NULL,
  deleted_by INTEGER
);
CREATE INDEX idx_deleted_entries_at ON deleted_entries(deleted_at);
CREATE INDEX idx_deleted_entries_id ON deleted_entries(id);
