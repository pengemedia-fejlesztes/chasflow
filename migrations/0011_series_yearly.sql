-- Ismétlődés: éves (12 havonta) is lehet – a CHECK feltétel miatt a táblát újra kell építeni.
CREATE TABLE series_new (
  id TEXT PRIMARY KEY,
  leaf_id TEXT NOT NULL REFERENCES leaves(id),
  name TEXT NOT NULL,
  rep TEXT NOT NULL DEFAULT 'once' CHECK (rep IN ('once','monthly','quarterly','yearly')),
  day INTEGER NOT NULL DEFAULT 10
);
INSERT INTO series_new (id, leaf_id, name, rep, day) SELECT id, leaf_id, name, rep, day FROM series;
DROP TABLE series;
ALTER TABLE series_new RENAME TO series;
