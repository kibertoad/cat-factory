-- Initial schema for the Agent Architecture Board.
--
-- Every aggregate is scoped by `workspace_id` and keyed by a composite primary
-- key (workspace_id, id), so the stable seed ids can be reused across boards.
-- JSON-shaped fields (dependsOn, features, pipeline agentKinds, execution steps)
-- are stored as TEXT and (de)serialised in the repository mappers.

CREATE TABLE workspaces (
  id         TEXT    NOT NULL PRIMARY KEY,
  name       TEXT    NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE blocks (
  workspace_id         TEXT    NOT NULL,
  id                   TEXT    NOT NULL,
  title                TEXT    NOT NULL,
  type                 TEXT    NOT NULL,
  description          TEXT    NOT NULL DEFAULT '',
  pos_x                REAL    NOT NULL DEFAULT 0,
  pos_y                REAL    NOT NULL DEFAULT 0,
  status               TEXT    NOT NULL,
  progress             REAL    NOT NULL DEFAULT 0,
  depends_on           TEXT    NOT NULL DEFAULT '[]',
  execution_id         TEXT,
  level                TEXT    NOT NULL DEFAULT 'frame',
  parent_id            TEXT,
  confidence           REAL,
  confidence_threshold REAL,
  module_name          TEXT,
  features             TEXT,
  PRIMARY KEY (workspace_id, id)
);

CREATE INDEX idx_blocks_parent ON blocks (workspace_id, parent_id);

CREATE TABLE pipelines (
  workspace_id TEXT NOT NULL,
  id           TEXT NOT NULL,
  name         TEXT NOT NULL,
  agent_kinds  TEXT NOT NULL DEFAULT '[]',
  PRIMARY KEY (workspace_id, id)
);

CREATE TABLE executions (
  workspace_id  TEXT    NOT NULL,
  id            TEXT    NOT NULL,
  block_id      TEXT    NOT NULL,
  pipeline_id   TEXT    NOT NULL,
  pipeline_name TEXT    NOT NULL,
  steps         TEXT    NOT NULL DEFAULT '[]',
  current_step  INTEGER NOT NULL DEFAULT 0,
  status        TEXT    NOT NULL,
  PRIMARY KEY (workspace_id, id)
);

CREATE UNIQUE INDEX idx_executions_block ON executions (workspace_id, block_id);
