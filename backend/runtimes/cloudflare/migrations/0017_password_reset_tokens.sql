-- Password-reset tokens for the "forgot my password" flow. A user requests a reset;
-- an opaque token (delivered by email) is redeemed to set a new password. Only the
-- token's SHA-256 hash is stored — the raw token lives only in the emailed link.
-- Single-use (status flips to 'used') and expiring; mirrors the Node Drizzle table.
CREATE TABLE password_reset_tokens (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  token_hash TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX idx_password_reset_tokens_token ON password_reset_tokens (token_hash);
CREATE INDEX idx_password_reset_tokens_user ON password_reset_tokens (user_id, status);
