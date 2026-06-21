-- Provider-subscription token pool: per-workspace, per-vendor subscription
-- credentials (a Claude Pro/Max OAuth token, a ChatGPT Plus/Pro auth.json
-- bundle) that authenticate the Claude Code / Codex harnesses inside a per-run
-- container without an API key.
--
-- A workspace may connect MANY tokens per vendor (a pool); the dispatch path
-- leases one with usage-aware rotation, preferring the least-loaded token in the
-- current rolling window (round-robin by last_used_at is only the tiebreaker).
-- The credential is stored as an opaque SecretCipher envelope (AES-256-GCM) —
-- this table never holds plaintext.

CREATE TABLE provider_subscription_tokens (
  id                TEXT    NOT NULL,
  workspace_id      TEXT    NOT NULL,
  vendor            TEXT    NOT NULL,            -- 'claude' | 'codex'
  label             TEXT    NOT NULL,
  token_cipher      TEXT    NOT NULL,            -- SecretCipher envelope (no plaintext)
  created_at        INTEGER NOT NULL,
  last_used_at      INTEGER,                     -- null = never leased
  window_started_at INTEGER,                     -- start of the current usage window
  input_tokens      INTEGER NOT NULL DEFAULT 0,  -- tokens consumed this window
  output_tokens     INTEGER NOT NULL DEFAULT 0,
  request_count     INTEGER NOT NULL DEFAULT 0,
  deleted_at        INTEGER,                     -- tombstone
  PRIMARY KEY (id)
);

-- Lease/list a workspace's live pool for a vendor.
CREATE INDEX idx_provider_subs_pool
  ON provider_subscription_tokens (workspace_id, vendor, deleted_at);
