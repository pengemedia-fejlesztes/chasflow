-- Billingo-számla automatikus fizetettre állítása a banki jóváírás alapján: melyik banki tétel fizette ki
ALTER TABLE billingo_docs ADD COLUMN paid_by_tx TEXT;
