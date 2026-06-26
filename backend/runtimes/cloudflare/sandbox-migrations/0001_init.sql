-- Sandbox (the parallel prompt/model testing surface) — schema for the DEDICATED
-- `SANDBOX_DB` D1 database (its own binding + migrations lineage, applied separately
-- from the main DB's `migrations/`). Because this is its own database, the tables are
-- unprefixed: the database is the namespace. The Node facade mirrors this as a Postgres
-- `sandbox` schema (Drizzle). Shipped baselines are NOT stored (read live from
-- `@cat-factory/agents`); only candidate prompt versions are. JSON-shaped fields are
-- stored as TEXT JSON. See backend/CLAUDE.md "Keep the runtimes symmetric".

-- Candidate prompt-version lineages under test (origin always 'candidate').
CREATE TABLE prompt_versions (
  workspace_id   TEXT    NOT NULL,
  id             TEXT    NOT NULL,
  lineage_id     TEXT    NOT NULL,
  agent_kind     TEXT    NOT NULL,
  name           TEXT    NOT NULL,
  origin         TEXT    NOT NULL,
  system_text    TEXT    NOT NULL,
  base_prompt_id TEXT,
  version        INTEGER NOT NULL,
  parent_id      TEXT,
  labels         TEXT    NOT NULL DEFAULT '[]',
  created_at     INTEGER NOT NULL,
  created_by     TEXT,
  archived_at    INTEGER,
  PRIMARY KEY (workspace_id, id)
);
CREATE INDEX idx_sandbox_prompts_kind ON prompt_versions (workspace_id, agent_kind);

-- Fixtures (builtins seeded lazily on first list, plus workspace-authored ones).
CREATE TABLE fixtures (
  workspace_id TEXT    NOT NULL,
  id           TEXT    NOT NULL,
  kind         TEXT    NOT NULL,
  name         TEXT    NOT NULL,
  payload      TEXT,
  repo_ref     TEXT,
  objective    TEXT,
  origin       TEXT    NOT NULL,
  created_at   INTEGER NOT NULL,
  PRIMARY KEY (workspace_id, id)
);

-- Experiment definitions (the matrix is a JSON blob).
CREATE TABLE experiments (
  workspace_id  TEXT    NOT NULL,
  id            TEXT    NOT NULL,
  name          TEXT    NOT NULL,
  agent_kind    TEXT    NOT NULL,
  judge_model   TEXT    NOT NULL,
  repeats       INTEGER NOT NULL,
  status        TEXT    NOT NULL,
  matrix        TEXT    NOT NULL,
  budget_tokens INTEGER,
  created_at    INTEGER NOT NULL,
  created_by    TEXT,
  PRIMARY KEY (workspace_id, id)
);

-- Individual run cells (the results grid).
CREATE TABLE runs (
  workspace_id      TEXT    NOT NULL,
  id                TEXT    NOT NULL,
  experiment_id     TEXT    NOT NULL,
  prompt_version_id TEXT    NOT NULL,
  model             TEXT    NOT NULL,
  fixture_id        TEXT    NOT NULL,
  repeat_index      INTEGER NOT NULL,
  status            TEXT    NOT NULL,
  output_text       TEXT,
  usage             TEXT,
  latency_ms        INTEGER,
  branch            TEXT,
  pr_url            TEXT,
  diff              TEXT,
  error             TEXT,
  seed_sha          TEXT,
  prompt_label      TEXT    NOT NULL,
  started_at        INTEGER,
  finished_at       INTEGER,
  PRIMARY KEY (workspace_id, id)
);
CREATE INDEX idx_sandbox_runs_experiment ON runs (workspace_id, experiment_id);
CREATE INDEX idx_sandbox_runs_queued ON runs (workspace_id, experiment_id, status);

-- Per-cell grades (rubric dimension scores + optional objective signal). Grades are
-- listed per experiment by joining to `runs` on `run_id` (so the row stays a faithful
-- `SandboxGrade` with no denormalized experiment id).
CREATE TABLE grades (
  workspace_id   TEXT    NOT NULL,
  id             TEXT    NOT NULL,
  run_id         TEXT    NOT NULL,
  judge_model    TEXT    NOT NULL,
  scores         TEXT    NOT NULL DEFAULT '[]',
  weighted_total REAL    NOT NULL,
  objective      TEXT,
  created_at     INTEGER NOT NULL,
  PRIMARY KEY (workspace_id, id)
);
CREATE INDEX idx_sandbox_grades_run ON grades (workspace_id, run_id);
