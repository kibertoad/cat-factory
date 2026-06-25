-- Per-workspace spend budget. Moved out of the deployment-wide env vars
-- (SPEND_MONTHLY_LIMIT / SPEND_CURRENCY / SPEND_MODEL_PRICES) onto the workspace
-- settings row so a budget is tunable per workspace in the UI. All nullable;
-- NULL ⇒ the built-in DEFAULT_SPEND_PRICING base table.
ALTER TABLE workspace_settings ADD COLUMN spend_currency TEXT;
ALTER TABLE workspace_settings ADD COLUMN spend_monthly_limit REAL;
-- JSON object of per-model price overrides ({ "provider:model": {inputPerMillion, outputPerMillion} }).
ALTER TABLE workspace_settings ADD COLUMN spend_model_prices TEXT;
