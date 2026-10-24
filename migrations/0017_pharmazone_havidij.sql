-- Pharmazone havi díj összevonása egy sorba (egyszeri adatjavítás, kérésre):
-- a számla nevével létrehozott sorozat (Penge / 2026-000053, 1 497 889 Ft) a „Havi díj”, az októberi kiszámlázott
-- havi díj ehhez a sorozathoz tartozik, a régi XLS-tervből maradt, ugyanazon hónapokra eső 1 005 408 Ft-os
-- párhuzamos tervek a kukába kerülnek (visszaállíthatók). Más azonosítóra nincs hatása.
UPDATE series SET name = 'Havi díj' WHERE id = 'suew5pbnqm42t';
UPDATE entries SET name = 'Havi díj' WHERE series_id = 'suew5pbnqm42t' AND kind = 'plan';
UPDATE entries SET series_id = 'suew5pbnqm42t' WHERE id = 'i46ca3766b555019f' AND EXISTS (SELECT 1 FROM series WHERE id = 'suew5pbnqm42t');
INSERT INTO deleted_entries (id, kind, date, leaf_id, name, amount, series_id, done, tentative, source, ext_ref, link_id, note, updated_at, updated_by, deleted_at, deleted_by)
  SELECT id, kind, date, leaf_id, name, amount, series_id, done, tentative, source, ext_ref, link_id, note, updated_at, updated_by,
    CAST(strftime('%s', 'now') AS INTEGER) * 1000, NULL
  FROM entries WHERE id IN ('id18401782dce2241', 'i17f9b663fe19e6c0') AND done = 0
    AND EXISTS (SELECT 1 FROM series WHERE id = 'suew5pbnqm42t');
DELETE FROM entries WHERE id IN ('id18401782dce2241', 'i17f9b663fe19e6c0') AND done = 0 AND EXISTS (SELECT 1 FROM series WHERE id = 'suew5pbnqm42t');
