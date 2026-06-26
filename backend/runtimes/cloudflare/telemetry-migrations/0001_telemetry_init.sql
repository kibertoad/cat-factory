-- Schema for the dedicated telemetry database (the TELEMETRY_DB binding). Telemetry is
-- append-heavy, high-volume and short-retention — a very different write profile from
-- the transactional domain in the main DB — so it lives in its own D1 database. Both
-- tables are pruned by the retention sweep to the LLM_CALL_METRICS_RETENTION_DAYS window.

-- One metered LLM call: full prompt (delta-stored) / response and timing breakdown.
CREATE TABLE llm_call_metrics (
  id                  TEXT    NOT NULL PRIMARY KEY,
  workspace_id        TEXT    NOT NULL,
  execution_id        TEXT,
  agent_kind          TEXT    NOT NULL,
  provider            TEXT    NOT NULL,
  model               TEXT    NOT NULL,
  created_at          INTEGER NOT NULL,
  streaming           INTEGER NOT NULL DEFAULT 0,
  message_count       INTEGER NOT NULL DEFAULT 0,
  tool_count          INTEGER NOT NULL DEFAULT 0,
  request_max_tokens  INTEGER,
  prompt_tokens       INTEGER NOT NULL DEFAULT 0,
  cached_prompt_tokens INTEGER NOT NULL DEFAULT 0,
  completion_tokens   INTEGER NOT NULL DEFAULT 0,
  total_tokens        INTEGER NOT NULL DEFAULT 0,
  finish_reason       TEXT,
  upstream_ms         INTEGER NOT NULL DEFAULT 0,
  overhead_ms         INTEGER NOT NULL DEFAULT 0,
  total_ms            INTEGER NOT NULL DEFAULT 0,
  ok                  INTEGER NOT NULL DEFAULT 1,
  http_status         INTEGER,
  error_message       TEXT,
  prompt_text         TEXT    NOT NULL DEFAULT '',
  prompt_prefix_count INTEGER NOT NULL DEFAULT 0,
  prompt_hash         TEXT    NOT NULL DEFAULT '',
  response_text       TEXT    NOT NULL DEFAULT '',
  reasoning_text      TEXT    NOT NULL DEFAULT ''
);
CREATE INDEX idx_llm_call_metrics_execution
  ON llm_call_metrics (workspace_id, execution_id, created_at);
CREATE INDEX idx_llm_call_metrics_created ON llm_call_metrics (created_at);

-- The complete, redacted context provided to one container-agent dispatch: the composed
-- system + user prompts, the fragment bodies folded in, and the full content of the
-- files injected into the container. JSON-shaped columns are TEXT.
CREATE TABLE agent_context_snapshots (
  id            TEXT    NOT NULL PRIMARY KEY,
  workspace_id  TEXT    NOT NULL,
  execution_id  TEXT    NOT NULL,
  agent_kind    TEXT    NOT NULL,
  step_index    INTEGER NOT NULL,
  created_at    INTEGER NOT NULL,
  model         TEXT,
  harness       TEXT,
  system_prompt TEXT    NOT NULL DEFAULT '',
  user_prompt   TEXT    NOT NULL DEFAULT '',
  fragments     TEXT    NOT NULL DEFAULT '[]',
  context_files TEXT    NOT NULL DEFAULT '[]',
  extras        TEXT    NOT NULL DEFAULT '{}'
);
CREATE INDEX idx_agent_context_snapshots_execution
  ON agent_context_snapshots (workspace_id, execution_id, created_at);
CREATE INDEX idx_agent_context_snapshots_created ON agent_context_snapshots (created_at);
