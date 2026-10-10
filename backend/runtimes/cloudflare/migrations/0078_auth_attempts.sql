-- The durable auth-attempt ledger behind the password-endpoint throttle (SEC-4 /
-- durable-auth-rate-limiting.md). The in-process Map it replaces was per isolate, so the
-- effective brute-force cap was `MAX_ATTEMPTS x isolates`; this table is the
-- cross-replica window. One row per attempt, counted per bucket key (`<ip>:<email>`) AND
-- per client IP (the cross-email credential-stuffing aggregate), pruned aggressively by
-- the retention sweep (rows are junk minutes after the window closes).
-- Mirrors the Node Drizzle `authAttempts` table (db/tables/identity.ts); keep in step.
CREATE TABLE auth_attempts (
  id TEXT PRIMARY KEY,
  key TEXT NOT NULL,
  ip TEXT NOT NULL,
  at INTEGER NOT NULL
);
CREATE INDEX idx_auth_attempts_key ON auth_attempts (key, at);
CREATE INDEX idx_auth_attempts_ip ON auth_attempts (ip, at);
CREATE INDEX idx_auth_attempts_at ON auth_attempts (at);
