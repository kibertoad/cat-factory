-- Task-source integration: a workspace's connections to external task/issue
-- trackers (Jira, …) and local projections of the individual issues it has
-- imported from them. A sibling of the document-source tables (migration 0012),
-- but task-shaped: an issue is a structured record (status/type/assignee/…) used
-- as extra agent context, not a page body expanded into board structure.
--
-- Conventions follow the existing schema: aggregates are scoped by workspace,
-- timestamps are INTEGER epoch-ms, there are no foreign keys, and a soft-delete
-- `deleted_at` tombstone lets a workspace disconnect and reconnect.

-- At most one live connection per (workspace, source). The credential bag is a
-- JSON object of string→string, encrypted at rest (AES-256-GCM envelope) and
-- never sent on the wire; it is read only by the import path to authenticate.
CREATE TABLE task_connections (
  workspace_id  TEXT    NOT NULL,
  source        TEXT    NOT NULL,
  credentials   TEXT    NOT NULL,
  label         TEXT    NOT NULL DEFAULT '',
  created_at    INTEGER NOT NULL,
  deleted_at    INTEGER,
  PRIMARY KEY (workspace_id, source)
);

-- One row per imported issue. The structured fields back the agent-context
-- injection; `labels` and `comments` are JSON; `description` is normalized
-- Markdown; `excerpt` is a short plain-text preview. `linked_block_id` attaches
-- the issue to a board block as agent context.
CREATE TABLE tasks (
  workspace_id     TEXT    NOT NULL,
  source           TEXT    NOT NULL,
  external_id      TEXT    NOT NULL,  -- issue key, e.g. PROJ-123
  title            TEXT    NOT NULL,
  url              TEXT    NOT NULL,
  status           TEXT    NOT NULL DEFAULT '',
  type             TEXT    NOT NULL DEFAULT '',
  assignee         TEXT,
  priority         TEXT,
  labels           TEXT    NOT NULL DEFAULT '[]',  -- JSON array of strings
  description      TEXT    NOT NULL DEFAULT '',
  comments         TEXT    NOT NULL DEFAULT '[]',  -- JSON array of {author,createdAt,body}
  excerpt          TEXT    NOT NULL DEFAULT '',
  linked_block_id  TEXT,
  synced_at        INTEGER NOT NULL,
  deleted_at       INTEGER,
  PRIMARY KEY (workspace_id, source, external_id)
);
-- Supports the execution engine's "issues linked to this block" lookup.
CREATE INDEX idx_tasks_block
  ON tasks (workspace_id, linked_block_id);
