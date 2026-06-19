-- Merge lifecycle: per-task merge threshold presets, human-actionable
-- notifications, and the task's selected preset.
--
-- A `merger` agent scores a PR (complexity/risk/impact) and the engine compares
-- those scores against the task's resolved preset to auto-merge or raise a
-- `merge_review` notification. Presets are a small per-workspace library; one is
-- the default (used by tasks that pick none). The preset also carries the
-- CI-fixer attempt budget gating the `ci` step.
--
-- Notifications are first-class human-actionable items surfaced on the board that
-- outlive the run that raised them (a PR needing a merge decision, a no-merger
-- pipeline awaiting confirmation, CI that gave up). The `payload` column holds a
-- small JSON blob (the agent's assessment, the PR url, the pipeline name).

-- Which preset a task selected (null → the workspace default).
ALTER TABLE blocks ADD COLUMN merge_preset_id TEXT;

CREATE TABLE merge_threshold_presets (
  workspace_id    TEXT    NOT NULL,
  id              TEXT    NOT NULL,
  name            TEXT    NOT NULL,
  max_complexity  REAL    NOT NULL,
  max_risk        REAL    NOT NULL,
  max_impact      REAL    NOT NULL,
  ci_max_attempts INTEGER NOT NULL,
  is_default      INTEGER NOT NULL DEFAULT 0,   -- 0/1; exactly one per workspace
  created_at      INTEGER NOT NULL,
  PRIMARY KEY (workspace_id, id)
);

-- Fast lookup of a workspace's default preset.
CREATE INDEX idx_merge_presets_default
  ON merge_threshold_presets (workspace_id, is_default);

CREATE TABLE notifications (
  workspace_id  TEXT    NOT NULL,
  id            TEXT    NOT NULL,
  type          TEXT    NOT NULL,            -- 'merge_review' | 'pipeline_complete' | 'ci_failed'
  status        TEXT    NOT NULL,            -- 'open' | 'acted' | 'dismissed'
  block_id      TEXT,
  execution_id  TEXT,
  title         TEXT    NOT NULL,
  body          TEXT    NOT NULL,
  payload       TEXT,                        -- JSON: { assessment?, prUrl?, pipelineName? }
  created_at    INTEGER NOT NULL,
  resolved_at   INTEGER,
  PRIMARY KEY (workspace_id, id)
);

-- The board inbox lists open notifications; the engine de-dupes by (block, type).
CREATE INDEX idx_notifications_open ON notifications (workspace_id, status, created_at);
CREATE INDEX idx_notifications_block ON notifications (workspace_id, block_id, type, status);
