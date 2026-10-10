-- Per-workspace opt-out for the engine-maintained PR verification report.
-- Defaults to 1 (on), matching `DEFAULT_WORKSPACE_SETTINGS`, so existing workspaces keep
-- publishing without an explicit choice. Mirrored by the Node facade's Drizzle migration.
ALTER TABLE workspace_settings ADD COLUMN publish_pr_verification_report INTEGER NOT NULL DEFAULT 1;
