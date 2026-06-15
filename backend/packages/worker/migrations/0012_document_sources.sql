-- Document-source integration: a workspace's connections to external document
-- sources (Confluence, Notion, …) and local projections of the requirement /
-- RFC / PRD pages it has imported from them. Supersedes the Confluence-specific
-- tables (migration 0005): a `source` discriminator tags every row, so one pair
-- of tables serves every provider. The cached page body (normalized to Markdown)
-- backs both the doc → board planner and the agent-context injection.
--
-- Conventions follow the existing schema: aggregates are scoped by workspace,
-- timestamps are INTEGER epoch-ms, there are no foreign keys, and a soft-delete
-- `deleted_at` tombstone lets a workspace disconnect and reconnect.

-- At most one live connection per (workspace, source). The credential bag is a
-- JSON object of string→string, stored plaintext-at-rest (like the cached GitHub
-- installation token) and never sent on the wire; it is read only by the import
-- path to authenticate to the source.
CREATE TABLE document_connections (
  workspace_id  TEXT    NOT NULL,
  source        TEXT    NOT NULL,
  credentials   TEXT    NOT NULL,
  label         TEXT    NOT NULL DEFAULT '',
  created_at    INTEGER NOT NULL,
  deleted_at    INTEGER,
  PRIMARY KEY (workspace_id, source)
);

-- One row per imported page. `body` holds the normalized Markdown (consumed by
-- the planner); `excerpt` is a short plain-text preview. `linked_block_id`
-- attaches the page to a board block as agent context.
CREATE TABLE documents (
  workspace_id     TEXT    NOT NULL,
  source           TEXT    NOT NULL,
  external_id      TEXT    NOT NULL,
  title            TEXT    NOT NULL,
  url              TEXT    NOT NULL,
  excerpt          TEXT    NOT NULL DEFAULT '',
  body             TEXT    NOT NULL DEFAULT '',
  linked_block_id  TEXT,
  synced_at        INTEGER NOT NULL,
  deleted_at       INTEGER,
  PRIMARY KEY (workspace_id, source, external_id)
);
-- Supports the execution engine's "documents linked to this block" lookup.
CREATE INDEX idx_documents_block
  ON documents (workspace_id, linked_block_id);

-- Carry over any live Confluence connections/documents from migration 0005, then
-- drop the superseded tables. Only live rows are migrated (the new schema keys
-- connections by (workspace_id, source), so historical tombstones can't collide).
INSERT INTO document_connections (workspace_id, source, credentials, label, created_at, deleted_at)
  SELECT workspace_id, 'confluence',
         json_object('baseUrl', base_url, 'accountEmail', account_email, 'apiToken', api_token),
         base_url, created_at, NULL
  FROM confluence_connections
  WHERE deleted_at IS NULL;

INSERT INTO documents (workspace_id, source, external_id, title, url, excerpt, body, linked_block_id, synced_at, deleted_at)
  SELECT workspace_id, 'confluence', page_id, title, url, excerpt, body, linked_block_id, synced_at, NULL
  FROM confluence_documents
  WHERE deleted_at IS NULL;

DROP TABLE confluence_documents;
DROP TABLE confluence_connections;
