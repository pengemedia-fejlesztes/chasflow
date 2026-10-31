-- Munkaidő-elszámolás: a feladatsor összege euróban (a „Feladatok” lap „Összeg (EUR)” oszlopa) – a munkaköltség ennek arányában oszlik meg.
ALTER TABLE worktime ADD COLUMN eur REAL NOT NULL DEFAULT 0;
