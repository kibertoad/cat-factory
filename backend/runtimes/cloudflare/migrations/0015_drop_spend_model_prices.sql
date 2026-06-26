-- Per-model price overrides are removed: a workspace's budget is now just a
-- currency + monthly limit overlaid on the built-in DEFAULT_SPEND_PRICING table.
-- Drop the now-unused JSON overrides column (pre-1.0; stale data may simply break).
ALTER TABLE workspace_settings DROP COLUMN spend_model_prices;
