-- Munkatársak ledolgozott ideje (Clockify-szerű havi XLS importból): hónap × projekt × feladattípus, percben.
-- A fedezeti pont riport ebből és a cashflow tényeiből számol (munkaköltség projektenként, cég fedezeti pontja).
CREATE TABLE IF NOT EXISTS employees (
  key TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  -- a munkatárs költsége ezen a (kiadási) alkategórián fut a cashflow-ban (pl. „Zuban Erna”)
  cost_leaf_id TEXT,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS worktime (
  employee TEXT NOT NULL,
  ym TEXT NOT NULL,
  project TEXT NOT NULL,
  tag TEXT NOT NULL DEFAULT '',
  minutes INTEGER NOT NULL,
  PRIMARY KEY (employee, ym, project, tag)
);
CREATE INDEX IF NOT EXISTS worktime_ym ON worktime(ym);
