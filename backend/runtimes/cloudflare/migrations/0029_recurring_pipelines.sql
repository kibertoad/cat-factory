-- Recurring pipelines: scheduled re-runs of a pipeline against a service, plus the
-- workspace's issue-tracker selection (where the tech-debt pipeline files its ticket).
--
-- A `pipeline_schedules` row attaches a pipeline to a service frame and owns one
-- reused on-board block (`block_id`); the cron sweeper fires every enabled schedule
-- whose `next_run_at <= now` by starting its pipeline against that block (skipping
-- any whose block already has an active run). Each fire is recorded in
-- `pipeline_schedule_runs` for the inspector's history (pruned to ~1 week by the
-- retention sweep). `tracker_settings` holds one row per workspace.

CREATE TABLE pipeline_schedules (
  workspace_id      TEXT    NOT NULL,
  id                TEXT    NOT NULL,
  block_id          TEXT    NOT NULL,          -- the reused on-board task block
  frame_id          TEXT    NOT NULL,          -- the service frame it lives in
  pipeline_id       TEXT    NOT NULL,
  template          TEXT    NOT NULL,          -- 'dep-update' | 'tech-debt' | 'custom'
  name              TEXT    NOT NULL,
  interval_hours    INTEGER NOT NULL,
  weekdays          TEXT    NOT NULL DEFAULT '[]',  -- JSON array of 0..6 (empty = every day)
  window_start_hour INTEGER,                   -- allowed hour-of-day window [start, end)
  window_end_hour   INTEGER,
  timezone          TEXT    NOT NULL DEFAULT 'UTC',
  enabled           INTEGER NOT NULL DEFAULT 1,
  last_run_at       INTEGER,
  next_run_at       INTEGER NOT NULL,
  created_at        INTEGER NOT NULL,
  PRIMARY KEY (workspace_id, id)
);

-- The sweeper's cross-workspace due query: enabled schedules ordered by next fire.
CREATE INDEX idx_pipeline_schedules_due ON pipeline_schedules (enabled, next_run_at);
-- Resolve a schedule from its reused block (inspector / board badge).
CREATE INDEX idx_pipeline_schedules_block ON pipeline_schedules (workspace_id, block_id);

CREATE TABLE pipeline_schedule_runs (
  workspace_id  TEXT    NOT NULL,
  id            TEXT    NOT NULL,
  schedule_id   TEXT    NOT NULL,
  execution_id  TEXT,
  status        TEXT    NOT NULL,              -- 'running' | 'done' | 'failed' | 'skipped'
  started_at    INTEGER NOT NULL,
  finished_at   INTEGER,
  outcome       TEXT,
  PRIMARY KEY (workspace_id, id)
);

-- A schedule's history, most recent first.
CREATE INDEX idx_schedule_runs_schedule
  ON pipeline_schedule_runs (workspace_id, schedule_id, started_at);
-- Retention prune across all workspaces.
CREATE INDEX idx_schedule_runs_started ON pipeline_schedule_runs (started_at);

CREATE TABLE tracker_settings (
  workspace_id     TEXT NOT NULL PRIMARY KEY,
  tracker          TEXT,                       -- 'github' | 'jira' | null
  jira_project_key TEXT,
  updated_at       INTEGER NOT NULL
);
