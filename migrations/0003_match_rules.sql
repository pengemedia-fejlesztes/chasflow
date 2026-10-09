-- Automatikus párosítások: "a szöveg tartalmazza" szabályok (pl. „tranzakciós díj” → Bank költség),
-- opcionális automatikus jóváhagyással. A tanult partner-szabályok is kaphatnak automatikus jóváhagyást.
CREATE TABLE match_rules (
  id TEXT PRIMARY KEY,
  pattern TEXT NOT NULL,          -- normalizált szövegrészlet (partner + közlemény)
  leaf_id TEXT NOT NULL,
  auto INTEGER NOT NULL DEFAULT 0, -- 1 = jóváhagyás nélkül könyveli
  note TEXT,
  source TEXT NOT NULL DEFAULT 'manual', -- manual | builtin
  hits INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL
);
ALTER TABLE partner_rules ADD COLUMN auto INTEGER NOT NULL DEFAULT 0;
