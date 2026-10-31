-- Havidíj neve a hónappal: „Havi díj” → „Havi díj – 2026. október” (a díj hónapja: period, különben a dátum hónapja).
-- A hónap (period) is rögzül, így a fizetés napja tételenként szabadon mozgatható, a név (melyik hónapé) marad.
UPDATE entries
SET period = COALESCE(period, substr(date, 1, 7)),
    name = trim(name) || ' – ' || substr(COALESCE(period, date), 1, 4) || '. ' ||
      CASE substr(COALESCE(period, date), 6, 2)
        WHEN '01' THEN 'január' WHEN '02' THEN 'február' WHEN '03' THEN 'március' WHEN '04' THEN 'április'
        WHEN '05' THEN 'május' WHEN '06' THEN 'június' WHEN '07' THEN 'július' WHEN '08' THEN 'augusztus'
        WHEN '09' THEN 'szeptember' WHEN '10' THEN 'október' WHEN '11' THEN 'november' ELSE 'december' END
WHERE kind = 'plan'
  AND lower(trim(name)) IN ('havi díj', 'havi dij', 'havidíj', 'havidij', 'havi díj ', 'havi dij ');
