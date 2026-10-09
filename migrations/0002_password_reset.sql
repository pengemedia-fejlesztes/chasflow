-- Elfelejtett jelszó: egyszer használható, rövid életű visszaállító tokenek (csak a hash-üket tároljuk)
CREATE TABLE password_resets (
  token_hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at INTEGER,
  ip TEXT
);
CREATE INDEX idx_password_resets_user ON password_resets(user_id);

CREATE TABLE reset_requests (
  ip TEXT NOT NULL,
  ts INTEGER NOT NULL
);
CREATE INDEX idx_reset_requests ON reset_requests(ip, ts);
