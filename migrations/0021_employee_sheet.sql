-- Munkatárs / alvállalkozó elszámoló táblája (Google Sheet link, „bárki, akinek megvan a link” – megtekintő):
-- ebből tölti be a program a havi munkát projektenként (a partner adatlapján kötelező megadni).
ALTER TABLE employees ADD COLUMN sheet_url TEXT;
-- Baka Aranka az alvállalkozók közé kerül (kérésre). Csak ha még a munkatársak csoportjában van.
UPDATE leaves SET group_id = 'g_d7b8bc90' WHERE id = 'l_6afa1cbd' AND group_id = 'g_c650563c';
