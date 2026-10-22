-- Ajánlat időpontjai: mikor lett ajánlatként felvéve (offer_at), mikor fogadták el (accepted_at) – az elfogadási időhöz
ALTER TABLE entries ADD COLUMN offer_at INTEGER;
ALTER TABLE entries ADD COLUMN accepted_at INTEGER;
ALTER TABLE deleted_entries ADD COLUMN offer_at INTEGER;
-- a még nyitott ajánlatoknál a legutóbbi módosítás a legjobb közelítés a felvitel idejére
UPDATE entries SET offer_at = updated_at WHERE tentative = 1 AND offer_at IS NULL;
