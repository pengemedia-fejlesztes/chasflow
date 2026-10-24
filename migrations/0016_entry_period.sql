-- A tétel hónapja (YYYY-MM): melyik hónap díja (pl. havidíj), ha a számlázás / fizetés később történik, mint a hónap
ALTER TABLE entries ADD COLUMN period TEXT;
