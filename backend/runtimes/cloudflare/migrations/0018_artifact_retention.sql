-- Per-workspace retention window (days) for binary artifacts (UI screenshots + uploaded
-- reference design images). The cleanup sweep deletes a workspace's artifacts — bytes and
-- metadata — once they age past this. Default 14 days; configurable in the UI.
ALTER TABLE workspace_settings ADD COLUMN artifact_retention_days INTEGER NOT NULL DEFAULT 14;
