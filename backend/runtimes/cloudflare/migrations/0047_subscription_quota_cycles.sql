-- Subscription quota-cycle tracking (usage-and-quota-tracking, Part B1): the modeled
-- rolling-window counters behind "how much of a subscription's quota cycle is left".
--
-- A subscription harness (Claude Code / Codex / GLM / pooled Kimi & DeepSeek) runs on a
-- flat-rate quota, not per-token billing, so the spend ledger excludes it. This table
-- instead folds each finished run's tokens into per-window counters anchored at first
-- observed use — the MODELED fallback used until a real vendor read (Part B2) supersedes
-- it. One row per (scope, scope_id, vendor, window_kind):
--   scope     'pooled' (a workspace pool token; scope_id = provider_subscription_tokens.id)
--          or 'user'   (a personal individual-usage subscription; scope_id = user id)
--   window_kind '5h' | 'weekly' — each accumulates the same tokens but resets on its own
--             cadence; window_started_at is the anchor, re-stamped when the window ages out.
CREATE TABLE subscription_quota_cycles (
  id TEXT NOT NULL,
  scope TEXT NOT NULL,
  scope_id TEXT NOT NULL,
  vendor TEXT NOT NULL,
  window_kind TEXT NOT NULL,
  window_started_at INTEGER NOT NULL,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  request_count INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (id),
  UNIQUE (scope, scope_id, vendor, window_kind)
);

-- Report reads list a scope's cycles by (scope, scope_id, vendor); the unique index above
-- covers that prefix. A dedicated index for the retention prune by window_started_at.
CREATE INDEX idx_subscription_quota_cycles_window
  ON subscription_quota_cycles (window_started_at);
