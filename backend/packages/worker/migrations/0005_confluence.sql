-- Confluence integration: a workspace's connection to a Confluence Cloud site,
-- and local projections of the requirement/RFC/PRD pages it has imported. The
-- cached page body backs both the doc → board planner and the agent-context
-- injection, so neither path re-fetches the page on every read.
--
-- Conventions follow the existing schema (0001/0004): aggregates are scoped by
-- workspace, timestamps are INTEGER epoch-ms, there are no foreign keys, and a
-- soft-delete `deleted_at` tombstone with a partial unique index lets a workspace
-- disconnect and reconnect without the binding colliding.

-- At most one *live* Confluence connection per workspace. The API token is stored
-- as plaintext-at-rest (like github_installations.cached_token) and is never sent
-- on the wire; it is read only by the import path to authenticate to the site.
CREATE TABLE confluence_connections (
  workspace_id   TEXT    NOT NULL,
  base_url       TEXT    NOT NULL,
  account_email  TEXT    NOT NULL,
  api_token      TEXT    NOT NULL,
  created_at     INTEGER NOT NULL,
  deleted_at     INTEGER,
  PRIMARY KEY (workspace_id, account_email)
);
-- A workspace connects to at most one live site. Partial so a tombstoned binding
-- doesn't block reconnecting the workspace to a new account.
CREATE UNIQUE INDEX idx_confluence_conn_workspace
  ON confluence_connections (workspace_id)
  WHERE deleted_at IS NULL;

-- One row per imported Confluence page. `body` holds the full storage-format
-- XHTML (consumed by the planner); `excerpt` is a short plain-text preview.
-- `linked_block_id` attaches the page to a board block as agent context.
CREATE TABLE confluence_documents (
  workspace_id     TEXT    NOT NULL,
  page_id          TEXT    NOT NULL,
  space_key        TEXT    NOT NULL,
  title            TEXT    NOT NULL,
  url              TEXT    NOT NULL,
  version          INTEGER NOT NULL DEFAULT 0,
  excerpt          TEXT    NOT NULL DEFAULT '',
  body             TEXT    NOT NULL DEFAULT '',
  linked_block_id  TEXT,
  synced_at        INTEGER NOT NULL,
  deleted_at       INTEGER,
  PRIMARY KEY (workspace_id, page_id)
);
-- Supports the execution engine's "documents linked to this block" lookup.
CREATE INDEX idx_confluence_docs_block
  ON confluence_documents (workspace_id, linked_block_id);
