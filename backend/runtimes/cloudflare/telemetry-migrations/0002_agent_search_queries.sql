-- Agent-search-query observability sink (see the kernel `agent-search-queries` port).
-- One row per web search a container agent performed through the backend search proxy.
-- Lives in the dedicated telemetry database (TELEMETRY_DB) alongside llm_call_metrics
-- and agent_context_snapshots, and is pruned by the retention sweep to the same
-- LLM_CALL_METRICS_RETENTION_DAYS window.
CREATE TABLE agent_search_queries (
  id           TEXT    NOT NULL PRIMARY KEY,
  workspace_id TEXT    NOT NULL,
  execution_id TEXT    NOT NULL,
  agent_kind   TEXT    NOT NULL,
  provider     TEXT,
  query        TEXT    NOT NULL DEFAULT '',
  result_count INTEGER NOT NULL DEFAULT 0,
  created_at   INTEGER NOT NULL
);
CREATE INDEX idx_agent_search_queries_execution
  ON agent_search_queries (workspace_id, execution_id, created_at);
CREATE INDEX idx_agent_search_queries_created ON agent_search_queries (created_at);
