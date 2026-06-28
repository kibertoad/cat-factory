-- Per-user personal document-source connections (descriptor `credentialScope: 'user'`),
-- e.g. a Claude Design personal access token. Same shape as `document_connections` but
-- keyed by the owning user instead of the workspace, so a personal credential is stored
-- once per user and never shared with the rest of the workspace. Credentials are
-- AES-256-GCM encrypted at rest (the `v1.*` envelope), exactly like the workspace table.
CREATE TABLE user_document_connections (
  user_id     TEXT NOT NULL,
  source      TEXT NOT NULL,
  credentials TEXT NOT NULL,
  label       TEXT NOT NULL DEFAULT '',
  created_at  INTEGER NOT NULL,
  deleted_at  INTEGER,
  PRIMARY KEY (user_id, source)
);
