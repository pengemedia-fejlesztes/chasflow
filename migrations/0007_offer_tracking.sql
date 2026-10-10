-- Ajánlatok követése: ha egy tétel valaha ajánlat volt, megmarad (megnyert ajánlat = ajánlatból lett biztos terv / tény)
ALTER TABLE entries ADD COLUMN was_offer INTEGER NOT NULL DEFAULT 0;
UPDATE entries SET was_offer = 1 WHERE tentative = 1;
