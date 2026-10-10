-- Számla ↔ terv: az eredeti tervösszeg megmarad (alulszámlázás figyeléséhez), partnerenkénti fizetési határidő (nap).
ALTER TABLE entries ADD COLUMN plan_amount INTEGER;
ALTER TABLE leaves ADD COLUMN pay_days INTEGER;
-- a korábban számlához kötött (és a számla nevére átnevezett) tervek visszakapják a partner tételnevét (pl. „Havi díj”)
UPDATE entries SET name = COALESCE(
    (SELECT e2.name FROM entries e2 WHERE e2.leaf_id = entries.leaf_id AND e2.kind = 'plan' AND e2.series_id IS NOT NULL
     GROUP BY e2.name ORDER BY count(*) DESC LIMIT 1), name)
  WHERE kind = 'plan' AND source = 'billingo' AND id NOT LIKE 'b%' AND name LIKE '% · Penge /%';
