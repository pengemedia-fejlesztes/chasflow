-- Partnertörzs: a partner (vevő / szállító) adatlapja. Egy partner = azonos nevű alkategóriák (bevételi és kiadási oldalon).
-- Alternatív nevek: cégnév, Billingo-számlanév, banki név, kút/üzlet nevek (pl. „OMV 135”, „Shell 27” → Tankolás) –
-- ezek alapján párosítja és vonja össze a banki, NAV és Billingo tételeket.
CREATE TABLE IF NOT EXISTS partners (
  key TEXT PRIMARY KEY,            -- a partner neve normalizálva (partnerIdOf)
  name TEXT NOT NULL,
  kind TEXT,                       -- vevo | szallito | mindketto (üres: a kategóriákból adódik)
  aliases TEXT NOT NULL DEFAULT '[]',
  tax_number TEXT,
  note TEXT,
  updated_at INTEGER NOT NULL
);
