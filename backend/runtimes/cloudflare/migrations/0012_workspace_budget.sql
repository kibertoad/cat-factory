-- Per-workspace spend budget. Moved out of the deployment-wide env vars
-- (SPEND_MONTHLY_LIMIT / SPEND_CURRENCY / SPEND_MODEL_PRICES) onto the workspace
-- settings row so a budget is tunable per workspace in the UI. All nullable;
-- NULL ⇒ the built-in DEFAULT_SPEND_PRICING base table.
ALTER TABLE workspace_settings ADD COLUMN spend_currency TEXT;
ALTER TABLE workspace_settings ADD COLUMN spend_monthly_limit REAL;
-- JSON object of per-model price overrides ({ "provider:model": {inputPerMillion, outputPerMillion} }).
ALTER TABLE workspace_settings ADD COLUMN spend_model_prices TEXT;

-- The spend gate now sums a SINGLE workspace's usage since the period start
-- (`totalsSinceForWorkspace`) on every metered LLM-proxy call + web-search + step,
-- not just the deployment-wide display rollup. Index (workspace_id, created_at) so that
-- hot-path aggregate doesn't scan the whole ledger and filter workspace_id row-by-row.
CREATE INDEX idx_token_usage_workspace ON token_usage (workspace_id, created_at);
