-- Fizetési nap szabályok (csoport / alkategória szinten) és banki tételek havi összevonása
ALTER TABLE groups ADD COLUMN pay_rule TEXT;  -- 'first_workday' | 'last_workday' | 'day:N'
ALTER TABLE leaves ADD COLUMN pay_rule TEXT;  -- felülírja a csoportét
ALTER TABLE match_rules ADD COLUMN merge INTEGER NOT NULL DEFAULT 0; -- 1 = havonta, bankonként egy tényben összevonva
ALTER TABLE partner_rules ADD COLUMN merge INTEGER NOT NULL DEFAULT 0;
