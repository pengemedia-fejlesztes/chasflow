-- A számlához kötött, a számla nevére átnevezett tervek visszakapják a partner tételnevét (pl. „Havi díj”),
-- a partner többi tervéből (sorozat nélküli, importált terveknél is) – így a táblázatban a tétel sorában maradnak.
UPDATE entries SET name = (
    SELECT e2.name FROM entries e2
    WHERE e2.leaf_id = entries.leaf_id AND e2.kind = 'plan' AND e2.id <> entries.id AND e2.name NOT LIKE '% · Penge /%' AND e2.name <> ''
    GROUP BY e2.name ORDER BY count(*) DESC LIMIT 1)
  WHERE kind = 'plan' AND source = 'billingo' AND id NOT LIKE 'b%' AND name LIKE '% · Penge /%'
    AND EXISTS (SELECT 1 FROM entries e3 WHERE e3.leaf_id = entries.leaf_id AND e3.kind = 'plan' AND e3.id <> entries.id
                AND e3.name NOT LIKE '% · Penge /%' AND e3.name <> '');
