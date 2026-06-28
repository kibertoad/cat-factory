-- Linear issue tracking: a workspace that files into Linear must name the team new
-- issues are created under (Linear's `issueCreate` requires a `teamId`). One nullable
-- column alongside the existing per-tracker target (`jira_project_key`); NULL unless
-- Linear is the selected filing tracker. The `task_connections` row (the API key) is
-- reused via its `source = 'linear'` discriminator — no schema change there.

ALTER TABLE tracker_settings ADD COLUMN linear_team_id TEXT;
