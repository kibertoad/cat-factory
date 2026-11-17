-- Which stage of its project's definition each project task runs, the upstream results it started
-- from, when it recorded its outcome, and when a person accepted that outcome at the stage's
-- checkpoint, naming the outcome accepted (a settled revision, or null for the result as recorded). A stage's state is derived
-- from these rows and the project's outcomes. A stage has at most one task with no recorded
-- outcome at a time: the partial unique index is the claim two concurrent starts race on.

CREATE TABLE project_stage_tasks (
  task_id      TEXT    PRIMARY KEY,
  project_id   TEXT    NOT NULL,
  stage_id     TEXT    NOT NULL,
  created_at   INTEGER NOT NULL,
  basis        TEXT    NOT NULL,
  recorded_at  INTEGER,
  cleared_at   INTEGER,
  cleared_by   TEXT,
  accepted_outcome_id TEXT
);
CREATE INDEX idx_project_stage_tasks_project ON project_stage_tasks (project_id);
CREATE UNIQUE INDEX idx_project_stage_tasks_open
  ON project_stage_tasks (project_id, stage_id) WHERE recorded_at IS NULL;
