-- A „Tagi kölcsön” közleményű utalás nem munkabér: külön „Tagi kölcsön” kiadási sorba kerül (az „Egyéb kiadás” mappába,
-- ha van, különben a munkabér mappájába), és a jövőbeli ilyen utalások is oda párosulnak.
INSERT OR IGNORE INTO leaves (id, group_id, label, sort)
SELECT 'l_tagi_kolcson',
       COALESCE((SELECT g.id FROM groups g WHERE g.section = 'out' AND lower(g.label) LIKE '%egyéb kiadás%' LIMIT 1), l.group_id),
       'Tagi kölcsön', 0
FROM leaves l JOIN groups g ON g.id = l.group_id
WHERE l.label = 'Nagy László' AND g.section = 'out'
  AND NOT EXISTS (SELECT 1 FROM leaves x JOIN groups y ON y.id = x.group_id WHERE x.label = 'Tagi kölcsön' AND y.section = 'out' AND x.archived = 0)
LIMIT 1;
UPDATE entries
SET leaf_id = (SELECT x.id FROM leaves x JOIN groups y ON y.id = x.group_id WHERE x.label = 'Tagi kölcsön' AND y.section = 'out' AND x.archived = 0 LIMIT 1)
WHERE kind = 'actual'
  AND id IN (SELECT actual_id FROM bank_tx WHERE amount < 0 AND actual_id IS NOT NULL AND (memo LIKE '%Tagi kölcsön%' OR memo LIKE '%tagi kolcson%'))
  AND leaf_id IN (SELECT l.id FROM leaves l WHERE l.label = 'Nagy László');
UPDATE bank_tx
SET leaf_id = (SELECT x.id FROM leaves x JOIN groups y ON y.id = x.group_id WHERE x.label = 'Tagi kölcsön' AND y.section = 'out' AND x.archived = 0 LIMIT 1)
WHERE amount < 0 AND (memo LIKE '%Tagi kölcsön%' OR memo LIKE '%tagi kolcson%')
  AND leaf_id IN (SELECT l.id FROM leaves l WHERE l.label = 'Nagy László');
INSERT INTO match_rules (id, pattern, leaf_id, auto, merge, note, source, updated_at)
SELECT 'r_tagi_kolcson', 'tagi kolcson', x.id, 0, 0, 'Tagi kölcsön (nem munkabér)', 'manual', CAST(strftime('%s', 'now') AS INTEGER) * 1000
FROM leaves x JOIN groups y ON y.id = x.group_id WHERE x.label = 'Tagi kölcsön' AND y.section = 'out' AND x.archived = 0
LIMIT 1
ON CONFLICT(id) DO NOTHING;
