-- Két, véletlenül „Nem kell terv” jelölt bejövő számla visszanyitása (Szilvási Trader, Optivi) – kérésre.
UPDATE nav_invoices SET status = 'new' WHERE status = 'ignored' AND invoice_number IN ('WEBSZT2026/006747', 'FUGEA0908648');
