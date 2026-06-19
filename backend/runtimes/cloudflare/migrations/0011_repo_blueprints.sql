-- Board-scan feature: the persisted "repository blueprint" — a decomposition of
-- one repository into the canonical service → modules → features tree, anchored
-- to codebase paths. Exactly one blueprint is kept per (workspace, repo): a
-- re-scan replaces it in place, so the row is the single current map rather than
-- an append-only log.
--
-- Conventions follow the existing schema (0001/0004/0010): aggregates are scoped
-- by workspace, timestamps are INTEGER epoch-ms, and there are no foreign keys.
-- The tree is stored as a JSON blob in `service_json` (read/written whole), like
-- other structured-but-opaque payloads in the projections.

CREATE TABLE repo_blueprints (
  id           TEXT    NOT NULL PRIMARY KEY,
  workspace_id TEXT    NOT NULL,
  repo_owner   TEXT    NOT NULL,
  repo_name    TEXT    NOT NULL,
  source       TEXT    NOT NULL,
  service_json TEXT    NOT NULL,
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL
);

-- One blueprint per repository within a workspace (enforces the upsert key).
CREATE UNIQUE INDEX idx_repo_blueprints_repo
  ON repo_blueprints (workspace_id, repo_owner, repo_name);

CREATE INDEX idx_repo_blueprints_workspace
  ON repo_blueprints (workspace_id, updated_at);
