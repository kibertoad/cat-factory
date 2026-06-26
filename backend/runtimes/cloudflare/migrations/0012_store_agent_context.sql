-- Per-workspace toggle for the agent-context observability feature. On by default
-- (1): the dispatch site records the complete provided context unless the workspace
-- turns it off (or the deployment disables prompt recording). Mirrors the Drizzle
-- `store_agent_context` column on workspace_settings (integer 0/1).
ALTER TABLE workspace_settings ADD COLUMN store_agent_context INTEGER NOT NULL DEFAULT 1;
