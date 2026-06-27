-- Binary-artifact METADATA (the bytes live in a blob backend — R2 on Cloudflare —
-- keyed by `storage_key`; D1 holds only the queryable metadata). Backs the
-- visual-confirmation gate: captured UI screenshots (kind='screenshot') and the
-- reference design images they are reviewed against (kind='reference'), paired by
-- `view`. There is deliberately NO blob column here: D1's ~1MB value limit makes
-- large-PNG-in-D1 a non-starter, so on Cloudflare the bytes always go to R2.
CREATE TABLE binary_artifacts (
  workspace_id  TEXT    NOT NULL,
  id            TEXT    NOT NULL,
  execution_id  TEXT,
  block_id      TEXT,
  kind          TEXT    NOT NULL,
  view          TEXT,
  content_type  TEXT    NOT NULL,
  byte_size     INTEGER NOT NULL,
  hash          TEXT    NOT NULL,
  storage       TEXT    NOT NULL,
  storage_key   TEXT    NOT NULL,
  created_at    INTEGER NOT NULL,
  PRIMARY KEY (workspace_id, id)
);
CREATE INDEX idx_binary_artifacts_execution ON binary_artifacts (workspace_id, execution_id);
CREATE INDEX idx_binary_artifacts_block ON binary_artifacts (workspace_id, block_id);
