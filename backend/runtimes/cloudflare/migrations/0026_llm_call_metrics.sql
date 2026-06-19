-- LLM observability sink. One row per proxied container-agent model call, captured
-- by the runtime-neutral LLM proxy (the single chokepoint that sees the full prompt,
-- the upstream response/usage, the output limit and the upstream timing). Unlike the
-- spend ledger (token_usage, which keeps only billed totals), this retains the full
-- request/response, the output-limit headroom and the latency split between transport
-- (proxy) overhead and actual model execution, so a run can be inspected end to end.
-- The full bodies make it heavy, so it is pruned aggressively by the retention cron
-- (default 3 days) via the created_at index.

CREATE TABLE llm_call_metrics (
  id                 TEXT    NOT NULL PRIMARY KEY,
  workspace_id       TEXT    NOT NULL,
  execution_id       TEXT,
  agent_kind         TEXT    NOT NULL,
  provider           TEXT    NOT NULL,
  model              TEXT    NOT NULL,
  created_at         INTEGER NOT NULL,
  streaming          INTEGER NOT NULL DEFAULT 0,
  message_count      INTEGER NOT NULL DEFAULT 0,
  tool_count         INTEGER NOT NULL DEFAULT 0,
  request_max_tokens INTEGER,
  prompt_tokens      INTEGER NOT NULL DEFAULT 0,
  completion_tokens  INTEGER NOT NULL DEFAULT 0,
  total_tokens       INTEGER NOT NULL DEFAULT 0,
  finish_reason      TEXT,
  upstream_ms        INTEGER NOT NULL DEFAULT 0,
  overhead_ms        INTEGER NOT NULL DEFAULT 0,
  total_ms           INTEGER NOT NULL DEFAULT 0,
  ok                 INTEGER NOT NULL DEFAULT 1,
  http_status        INTEGER,
  error_message      TEXT,
  prompt_text        TEXT    NOT NULL DEFAULT '',
  response_text      TEXT    NOT NULL DEFAULT ''
);

-- Per-run list + per-agent-kind rollups (the board drill-down and step summaries).
CREATE INDEX idx_llm_call_metrics_execution
  ON llm_call_metrics (workspace_id, execution_id, created_at);

-- Supports the retention sweep's "delete older than" range scan.
CREATE INDEX idx_llm_call_metrics_created ON llm_call_metrics (created_at);
