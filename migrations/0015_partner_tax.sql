-- Billingo-számla partnerének adószáma (a partnertörzs adószámának automatikus kitöltéséhez)
ALTER TABLE billingo_docs ADD COLUMN partner_tax TEXT;
