-- Minden tervtétel neve a hónapjával (egyszeri, ütemezett, havi – egy adat, egyformán): „Munkabér” → „Munkabér – 2026. október”.
UPDATE entries
SET period = COALESCE(period, substr(date, 1, 7)),
    name = trim(name) || ' – ' || substr(COALESCE(period, date), 1, 4) || '. ' || CASE substr(COALESCE(period, date), 6, 2) WHEN '01' THEN 'január' WHEN '02' THEN 'február' WHEN '03' THEN 'március' WHEN '04' THEN 'április' WHEN '05' THEN 'május' WHEN '06' THEN 'június' WHEN '07' THEN 'július' WHEN '08' THEN 'augusztus' WHEN '09' THEN 'szeptember' WHEN '10' THEN 'október' WHEN '11' THEN 'november' ELSE 'december' END
WHERE kind = 'plan' AND trim(name) <> ''
  AND name NOT GLOB '*[12][0-9][0-9][0-9]. *'
  AND lower(trim(name)) NOT LIKE '%január' AND lower(trim(name)) NOT LIKE '%február' AND lower(trim(name)) NOT LIKE '%március' AND lower(trim(name)) NOT LIKE '%április' AND lower(trim(name)) NOT LIKE '%május' AND lower(trim(name)) NOT LIKE '%június' AND lower(trim(name)) NOT LIKE '%július' AND lower(trim(name)) NOT LIKE '%augusztus' AND lower(trim(name)) NOT LIKE '%szeptember' AND lower(trim(name)) NOT LIKE '%október' AND lower(trim(name)) NOT LIKE '%november' AND lower(trim(name)) NOT LIKE '%december';
