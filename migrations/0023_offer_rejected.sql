-- Elutasított ajánlat: a kukába kerül, de megjelölve – így a sima törlés (pl. elírás) nem rontja az elfogadási arányt.
ALTER TABLE deleted_entries ADD COLUMN rejected INTEGER NOT NULL DEFAULT 0;
-- eddig minden törölt ajánlat elutasítottnak számított – ezek maradnak a statisztikában
UPDATE deleted_entries SET rejected = 1 WHERE tentative = 1;
