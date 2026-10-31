-- A Tibeko az IT szolgáltatás alatt van („Tibeko havi díj”) – a külön „Tibeko” kiadási sor duplikált (ugyanaz a 25 400 Ft
-- havonta). A külön sor dupla tervei törlődnek, a többi tétele, banki tétele és szabálya az IT szolgáltatáshoz kerül, a sor archiválódik.
DELETE FROM entries
WHERE kind = 'plan' AND done = 0
  AND leaf_id IN (SELECT l.id FROM leaves l JOIN groups g ON g.id = l.group_id WHERE l.label = 'Tibeko' AND g.section = 'out')
  AND EXISTS (
    SELECT 1 FROM entries p JOIN leaves l2 ON l2.id = p.leaf_id
    WHERE l2.label = 'IT szolgáltatás' AND p.kind = 'plan' AND p.amount = entries.amount AND substr(p.date, 1, 7) = substr(entries.date, 1, 7)
  );
UPDATE entries SET leaf_id = (SELECT l.id FROM leaves l JOIN groups g ON g.id = l.group_id WHERE l.label = 'IT szolgáltatás' AND g.section = 'out' AND l.archived = 0 LIMIT 1)
WHERE leaf_id IN (SELECT l.id FROM leaves l JOIN groups g ON g.id = l.group_id WHERE l.label = 'Tibeko' AND g.section = 'out')
  AND EXISTS (SELECT 1 FROM leaves l JOIN groups g ON g.id = l.group_id WHERE l.label = 'IT szolgáltatás' AND g.section = 'out' AND l.archived = 0);
UPDATE series SET leaf_id = (SELECT l.id FROM leaves l JOIN groups g ON g.id = l.group_id WHERE l.label = 'IT szolgáltatás' AND g.section = 'out' AND l.archived = 0 LIMIT 1)
WHERE leaf_id IN (SELECT l.id FROM leaves l JOIN groups g ON g.id = l.group_id WHERE l.label = 'Tibeko' AND g.section = 'out')
  AND EXISTS (SELECT 1 FROM leaves l JOIN groups g ON g.id = l.group_id WHERE l.label = 'IT szolgáltatás' AND g.section = 'out' AND l.archived = 0);
UPDATE bank_tx SET leaf_id = (SELECT l.id FROM leaves l JOIN groups g ON g.id = l.group_id WHERE l.label = 'IT szolgáltatás' AND g.section = 'out' AND l.archived = 0 LIMIT 1)
WHERE leaf_id IN (SELECT l.id FROM leaves l JOIN groups g ON g.id = l.group_id WHERE l.label = 'Tibeko' AND g.section = 'out')
  AND EXISTS (SELECT 1 FROM leaves l JOIN groups g ON g.id = l.group_id WHERE l.label = 'IT szolgáltatás' AND g.section = 'out' AND l.archived = 0);
UPDATE match_rules SET leaf_id = (SELECT l.id FROM leaves l JOIN groups g ON g.id = l.group_id WHERE l.label = 'IT szolgáltatás' AND g.section = 'out' AND l.archived = 0 LIMIT 1)
WHERE leaf_id IN (SELECT l.id FROM leaves l JOIN groups g ON g.id = l.group_id WHERE l.label = 'Tibeko' AND g.section = 'out')
  AND EXISTS (SELECT 1 FROM leaves l JOIN groups g ON g.id = l.group_id WHERE l.label = 'IT szolgáltatás' AND g.section = 'out' AND l.archived = 0);
UPDATE partner_rules SET leaf_id = (SELECT l.id FROM leaves l JOIN groups g ON g.id = l.group_id WHERE l.label = 'IT szolgáltatás' AND g.section = 'out' AND l.archived = 0 LIMIT 1)
WHERE leaf_id IN (SELECT l.id FROM leaves l JOIN groups g ON g.id = l.group_id WHERE l.label = 'Tibeko' AND g.section = 'out')
  AND EXISTS (SELECT 1 FROM leaves l JOIN groups g ON g.id = l.group_id WHERE l.label = 'IT szolgáltatás' AND g.section = 'out' AND l.archived = 0);
INSERT INTO partner_rules (pattern, leaf_id, hits, updated_at)
SELECT 'tibeko', l.id, 0, CAST(strftime('%s', 'now') AS INTEGER) * 1000 FROM leaves l JOIN groups g ON g.id = l.group_id
WHERE l.label = 'IT szolgáltatás' AND g.section = 'out' AND l.archived = 0 LIMIT 1
ON CONFLICT(pattern) DO UPDATE SET leaf_id = excluded.leaf_id;
UPDATE leaves SET archived = 1
WHERE label = 'Tibeko' AND group_id IN (SELECT id FROM groups WHERE section = 'out')
  AND EXISTS (SELECT 1 FROM leaves l JOIN groups g ON g.id = l.group_id WHERE l.label = 'IT szolgáltatás' AND g.section = 'out' AND l.archived = 0);
