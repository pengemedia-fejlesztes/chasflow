-- Havi terv–tény pillanatkép: a lezárt hónap egyszer számolódik (utána nem változik),
-- a folyó hónap minden reggel és kézi frissítéskor újraszámolódik.
CREATE TABLE month_stats (
  ym TEXT PRIMARY KEY,               -- YYYY-MM
  plan_in INTEGER NOT NULL DEFAULT 0,
  plan_out INTEGER NOT NULL DEFAULT 0,
  offer_in INTEGER NOT NULL DEFAULT 0,
  offer_out INTEGER NOT NULL DEFAULT 0,
  act_in INTEGER NOT NULL DEFAULT 0,
  act_out INTEGER NOT NULL DEFAULT 0,
  closed INTEGER NOT NULL DEFAULT 0, -- 1 = lezárt hónap (befagyasztva)
  computed_at INTEGER NOT NULL,
  computed_by INTEGER
);
