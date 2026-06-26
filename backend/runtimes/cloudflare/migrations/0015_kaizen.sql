-- Kaizen agent: post-run grading of completed agent steps + the verified-combo
-- library. A grading targets one step of a run (by step index), graded by its
-- (prompt version, agent kind, model) combo; the verified-combos table tracks each
-- combo's streak of high grades and flips `verified` once it crosses the threshold,
-- after which the engine stops scheduling gradings for it. Mirrors the Drizzle
-- `kaizen_gradings` / `kaizen_verified_combos` tables on the Node facade.

CREATE TABLE kaizen_gradings (
  workspace_id    TEXT    NOT NULL,
  id              TEXT    NOT NULL,
  execution_id    TEXT    NOT NULL,
  block_id        TEXT    NOT NULL,
  step_index      INTEGER NOT NULL,
  agent_kind      TEXT    NOT NULL,
  model           TEXT    NOT NULL,
  prompt_version  INTEGER NOT NULL,
  combo_key       TEXT    NOT NULL,
  status          TEXT    NOT NULL,
  grade           INTEGER,
  summary         TEXT    NOT NULL DEFAULT '',
  -- JSON array of recommendation strings.
  recommendations TEXT    NOT NULL DEFAULT '[]',
  grader_model    TEXT,
  error           TEXT,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL,
  PRIMARY KEY (workspace_id, id)
);

-- One grading per (run, step) — the schedule pass is idempotent on re-drive.
CREATE UNIQUE INDEX idx_kaizen_gradings_step
  ON kaizen_gradings(workspace_id, execution_id, step_index);
-- The background sweep pulls scheduled/running rows oldest-first.
CREATE INDEX idx_kaizen_gradings_status
  ON kaizen_gradings(status, updated_at);
-- The run window lists a run's gradings.
CREATE INDEX idx_kaizen_gradings_execution
  ON kaizen_gradings(workspace_id, execution_id);

CREATE TABLE kaizen_verified_combos (
  workspace_id            TEXT    NOT NULL,
  combo_key               TEXT    NOT NULL,
  agent_kind              TEXT    NOT NULL,
  model                   TEXT    NOT NULL,
  prompt_version          INTEGER NOT NULL,
  consecutive_high_grades INTEGER NOT NULL DEFAULT 0,
  verified                INTEGER NOT NULL DEFAULT 0,
  verified_at             INTEGER,
  updated_at              INTEGER NOT NULL,
  PRIMARY KEY (workspace_id, combo_key)
);

-- Per-workspace toggle for the Kaizen agent. On by default (1). Mirrors the Drizzle
-- `kaizen_enabled` column on workspace_settings (integer 0/1).
ALTER TABLE workspace_settings ADD COLUMN kaizen_enabled INTEGER NOT NULL DEFAULT 1;
