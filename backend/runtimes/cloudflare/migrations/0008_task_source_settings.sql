-- Per-workspace task-source toggle. A source (Jira / GitHub Issues) is offered as
-- soon as it is available unless a row here opts it out, so the absence of a row
-- means enabled. Replaces the deployment-level TASK_SOURCES env allow-list with a
-- workspace-controlled switch: e.g. a workspace using GitHub repos can disable
-- GitHub Issues without disabling them for every workspace on the deployment.
CREATE TABLE task_source_settings (
  workspace_id TEXT NOT NULL,
  source TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (workspace_id, source)
);
