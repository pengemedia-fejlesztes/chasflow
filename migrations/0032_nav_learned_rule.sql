-- NAV-számla besorolása: a tanult partner-szabály korábbi állapota (JSON), hogy a besorolás visszavonása
-- („reopen”) a tanulást is visszavonja. NULL = a besorolás nem tanult szabályt.
ALTER TABLE nav_invoices ADD COLUMN learned_rule TEXT;
