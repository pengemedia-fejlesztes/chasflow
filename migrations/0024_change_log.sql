-- Változásnapló: ki, mikor, mit módosított – visszavonható lépésekkel (undo = a visszaállításhoz szükséges korábbi állapot).
CREATE TABLE change_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  user_id INTEGER,
  action TEXT NOT NULL,
  summary TEXT NOT NULL,
  leaf_ids TEXT NOT NULL DEFAULT '',
  items TEXT,
  undo TEXT,
  undone_at INTEGER,
  undone_by INTEGER,
  undo_of INTEGER
);
CREATE INDEX change_log_ts ON change_log (ts);

-- Egyszeri javítás (kérésre): az „Orvosmost UrgentCare” projekt az Ajánlatok mappában lévő „Orvosmost” sorba lett összevonva,
-- így a biztos (nem ajánlat) tételei eltűntek a Projektekből. Az „Orvosmost” sor a Projektek mappába kerül; a naplóból visszavonható.
INSERT INTO change_log (ts, user_id, action, summary, leaf_ids, undo)
SELECT CAST(strftime('%s', 'now') AS INTEGER) * 1000, NULL, 'leaf.update',
  'Orvosmost áthelyezve: Ajánlatok → Projektek (adatjavítás az összevonás után)', ',l_de00a4a5,',
  json_object('type', 'leaf.update', 'id', 'l_de00a4a5', 'before', json_object('group_id', l.group_id))
FROM leaves l
WHERE l.id = 'l_de00a4a5' AND EXISTS (SELECT 1 FROM leaves p WHERE p.id = 'l_0008ee2f')
  AND NOT EXISTS (
    SELECT 1 FROM leaves duplicate JOIN leaves destination ON destination.id = 'l_0008ee2f'
    WHERE duplicate.group_id = destination.group_id AND duplicate.label = l.label AND duplicate.id <> l.id
  );
-- Ütköző címkénél a történeti adatjavítást teljes egészében kihagyjuk:
-- a séma települ, a kategóriák, szabályok és pénzügyi hivatkozások változatlanok maradnak.
UPDATE leaves AS l SET group_id = (SELECT group_id FROM leaves WHERE id = 'l_0008ee2f')
WHERE l.id = 'l_de00a4a5' AND EXISTS (SELECT 1 FROM leaves p WHERE p.id = 'l_0008ee2f')
  AND NOT EXISTS (
    SELECT 1 FROM leaves duplicate JOIN leaves destination ON destination.id = 'l_0008ee2f'
    WHERE duplicate.group_id = destination.group_id AND duplicate.label = l.label AND duplicate.id <> l.id
  );
-- az üres (tétel nélküli) másik „Orvosmost” projektsor szabályai az áthelyezett sorhoz kerülnek, maga a sor archiválódik
UPDATE partner_rules SET leaf_id = 'l_de00a4a5' WHERE leaf_id = 'l_0008ee2f' AND EXISTS (SELECT 1 FROM leaves source JOIN leaves destination ON destination.id = 'l_0008ee2f' WHERE source.id = 'l_de00a4a5' AND source.group_id = destination.group_id);
UPDATE match_rules SET leaf_id = 'l_de00a4a5' WHERE leaf_id = 'l_0008ee2f' AND EXISTS (SELECT 1 FROM leaves source JOIN leaves destination ON destination.id = 'l_0008ee2f' WHERE source.id = 'l_de00a4a5' AND source.group_id = destination.group_id);
UPDATE leaves SET archived = 1
WHERE id = 'l_0008ee2f' AND EXISTS (SELECT 1 FROM leaves source JOIN leaves destination ON destination.id = 'l_0008ee2f' WHERE source.id = 'l_de00a4a5' AND source.group_id = destination.group_id)
  AND NOT EXISTS (SELECT 1 FROM entries WHERE leaf_id = 'l_0008ee2f') AND NOT EXISTS (SELECT 1 FROM series WHERE leaf_id = 'l_0008ee2f');
