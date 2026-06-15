-- Repo-bootstrap feature: a workspace-scoped, CRUD-managed list of "reference
-- architectures" (base/golden-template repos new repositories are bootstrapped
-- from) and a log of "bootstrap repo" jobs, one row per run with its outcome.
--
-- Conventions follow the existing schema (0001/0004/0005/0008): aggregates are
-- scoped by workspace, timestamps are INTEGER epoch-ms, there are no foreign
-- keys, and reference architectures carry a soft-delete `deleted_at` tombstone.
-- Bootstrap jobs are an append-mostly log (no soft delete): they are inserted as
-- `running` and updated in place to their terminal `succeeded`/`failed` state.

-- The managed reference architecture list.
CREATE TABLE reference_architectures (
  id                   TEXT    NOT NULL PRIMARY KEY,
  workspace_id         TEXT    NOT NULL,
  name                 TEXT    NOT NULL,
  description          TEXT    NOT NULL DEFAULT '',
  repo_owner           TEXT    NOT NULL,
  repo_name            TEXT    NOT NULL,
  default_instructions TEXT    NOT NULL DEFAULT '',
  created_at           INTEGER NOT NULL,
  updated_at           INTEGER NOT NULL,
  deleted_at           INTEGER
);
CREATE INDEX idx_reference_architectures_workspace
  ON reference_architectures (workspace_id)
  WHERE deleted_at IS NULL;

-- One row per "bootstrap repo" run.
CREATE TABLE bootstrap_jobs (
  id                          TEXT    NOT NULL PRIMARY KEY,
  workspace_id                TEXT    NOT NULL,
  reference_architecture_id   TEXT    NOT NULL,
  reference_architecture_name TEXT    NOT NULL,
  repo_name                   TEXT    NOT NULL,
  repo_owner                  TEXT,
  repo_url                    TEXT,
  instructions                TEXT    NOT NULL DEFAULT '',
  status                      TEXT    NOT NULL,
  error                       TEXT,
  created_at                  INTEGER NOT NULL,
  updated_at                  INTEGER NOT NULL
);
CREATE INDEX idx_bootstrap_jobs_workspace
  ON bootstrap_jobs (workspace_id, created_at);
