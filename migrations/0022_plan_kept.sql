-- A terv összege soha nem íródik felül a számláéval (kérésre): a számla összege külön oszlopba kerül.
-- bill_amount = a tervhez kötött Billingo-számla bruttó összege.
ALTER TABLE entries ADD COLUMN bill_amount INTEGER;
-- A korábban a számla összegére átírt tervek visszakapják az eredeti tervösszeget; a számla összege a bill_amount-ba kerül.
UPDATE entries SET bill_amount = amount, amount = plan_amount
WHERE kind = 'plan' AND plan_amount IS NOT NULL AND ext_ref LIKE 'billingo:%';
-- a számlából létrejött (előzetes terv nélküli) tervek számlaösszege
UPDATE entries SET bill_amount = amount
WHERE kind = 'plan' AND bill_amount IS NULL AND ext_ref LIKE 'billingo:%';
