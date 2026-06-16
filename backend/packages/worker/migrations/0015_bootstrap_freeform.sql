-- Allow "bootstrap repo" runs with no reference architecture (freeform prompt).
-- The original 0010 schema declared `reference_architecture_id` and
-- `reference_architecture_name` NOT NULL; from-scratch runs leave them null, so
-- relax both columns. SQLite can't drop a NOT NULL constraint in place, so we
-- rebuild the table (12-step pattern: create new, copy, drop, rename, re-index).

CREATE TABLE bootstrap_jobs_new (
  id                          TEXT    NOT NULL PRIMARY KEY,
  workspace_id                TEXT    NOT NULL,
  reference_architecture_id   TEXT,
  reference_architecture_name TEXT,
  repo_name                   TEXT    NOT NULL,
  repo_owner                  TEXT,
  repo_url                    TEXT,
  instructions                TEXT    NOT NULL DEFAULT '',
  status                      TEXT    NOT NULL,
  error                       TEXT,
  created_at                  INTEGER NOT NULL,
  updated_at                  INTEGER NOT NULL
);

INSERT INTO bootstrap_jobs_new
  SELECT id, workspace_id, reference_architecture_id, reference_architecture_name,
         repo_name, repo_owner, repo_url, instructions, status, error,
         created_at, updated_at
  FROM bootstrap_jobs;

DROP TABLE bootstrap_jobs;
ALTER TABLE bootstrap_jobs_new RENAME TO bootstrap_jobs;

CREATE INDEX idx_bootstrap_jobs_workspace
  ON bootstrap_jobs (workspace_id, created_at);
