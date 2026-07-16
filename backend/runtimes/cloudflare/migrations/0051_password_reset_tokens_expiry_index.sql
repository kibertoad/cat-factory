-- `D1PasswordResetTokenRepository.deleteExpired` sweeps on `expires_at < ?` with no index
-- on `expires_at`, so it scans the whole table. Index it like every other TTL column in the
-- schema (idx_environments_expiry / idx_personal_subs_expiry) so the sweep is index-driven.
-- Mirrors the Node Drizzle `idx_password_reset_tokens_expiry` (schema.ts) — keep in step.
CREATE INDEX idx_password_reset_tokens_expiry ON password_reset_tokens (expires_at);
