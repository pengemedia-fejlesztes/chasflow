-- Balogh Óra-Ékszer, Penge / 2025-000138 (decemberi számla, 228 600 Ft) téves párosításának bontása (egyszeri adatjavítás, kérésre):
-- a 2026.05.19-i „Havi díj január” befizetés a januári számlát fizette, a decemberi a Billingo szerint is kifizetetlen.
-- A terv újra nyitott lesz (megjelenik a kintlévőségek között), a banki tény megmarad. Csak ezt az egy párosítást érinti.
UPDATE entries
SET done = 0,
    link_id = NULL,
    note = 'Párosítás bontva 2026.10.25.: a 2026.05.19-i „Havi díj január” befizetés a januári számlához tartozik; ez a számla nincs kifizetve.',
    updated_at = CAST(strftime('%s', 'now') AS INTEGER) * 1000
WHERE id = 'b114513606' AND link_id = 'i0166f7748c175df5';
UPDATE entries
SET link_id = NULL,
    updated_at = CAST(strftime('%s', 'now') AS INTEGER) * 1000
WHERE id = 'i0166f7748c175df5' AND link_id = 'b114513606';
