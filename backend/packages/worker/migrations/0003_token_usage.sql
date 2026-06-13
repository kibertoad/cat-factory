-- Spend safeguard ledger. One row per metered LLM call: the token counts and a
-- cost estimate priced at record time (so historical rows stay stable even if
-- pricing config changes). The budget is org-wide, so usage is summed across all
-- workspaces for the current billing period via the created_at index.

CREATE TABLE token_usage (
  id            TEXT    NOT NULL PRIMARY KEY,
  workspace_id  TEXT    NOT NULL,
  execution_id  TEXT,
  agent_kind    TEXT    NOT NULL,
  provider      TEXT    NOT NULL,
  model         TEXT    NOT NULL,
  input_tokens  INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  cost_estimate REAL    NOT NULL DEFAULT 0,
  created_at    INTEGER NOT NULL
);

-- Supports the "sum usage since the start of this period" budget query.
CREATE INDEX idx_token_usage_created ON token_usage (created_at);
