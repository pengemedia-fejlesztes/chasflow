-- A failed guard rolls back the entire D1 batch, including all related edits.
CREATE TABLE mutation_guard (
  ok INTEGER NOT NULL CONSTRAINT entry_version_conflict CHECK (ok = 1)
);
