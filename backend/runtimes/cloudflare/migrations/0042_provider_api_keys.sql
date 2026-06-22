-- Direct-provider API-key pool: UI-onboarded vendor API keys
-- (OpenAI/Anthropic/Qwen/DeepSeek/Moonshot) that authenticate the LLM proxy +
-- inline model calls, replacing the old deployment-env onboarding.
--
-- A key lives at one of three SCOPES — account, workspace, or user. When a run in
-- a workspace needs a provider key, the candidate pool is the UNION of the
-- workspace's keys, its owning account's keys, and the run initiator's own user
-- keys; the dispatch path leases one with usage-aware rotation (least-loaded in
-- the current rolling window; round-robin by last_used_at is only the tiebreaker).
-- The key is stored as an opaque SecretCipher envelope (AES-256-GCM) — this table
-- never holds plaintext.

CREATE TABLE provider_api_keys (
  id                TEXT    NOT NULL,
  scope             TEXT    NOT NULL,            -- 'account' | 'workspace' | 'user'
  scope_id          TEXT    NOT NULL,            -- account id | workspace id | usr_* id
  provider          TEXT    NOT NULL,            -- 'openai' | 'anthropic' | 'qwen' | 'deepseek' | 'moonshot'
  label             TEXT    NOT NULL,
  key_cipher        TEXT    NOT NULL,            -- SecretCipher envelope (no plaintext)
  created_at        INTEGER NOT NULL,
  last_used_at      INTEGER,                     -- null = never leased
  window_started_at INTEGER,                     -- start of the current usage window
  input_tokens      INTEGER NOT NULL DEFAULT 0,  -- tokens consumed this window
  output_tokens     INTEGER NOT NULL DEFAULT 0,
  request_count     INTEGER NOT NULL DEFAULT 0,
  deleted_at        INTEGER,                     -- tombstone
  PRIMARY KEY (id)
);

-- Lease/list a scope segment's live pool for a provider.
CREATE INDEX idx_provider_api_keys_pool
  ON provider_api_keys (scope, scope_id, provider, deleted_at);
