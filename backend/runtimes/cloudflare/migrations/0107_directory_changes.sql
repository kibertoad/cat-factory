-- The directory change feed (docs/initiatives/directory-sync.md): an append-only, per-account
-- ordered record of which directory entity changed. Rows name an entity and never carry its state.
-- `seq` is assigned as MAX(seq) + ROW_NUMBER() inside the writer's batch, which SQLite serializes,
-- so commit order equals seq order. No foreign keys: a row must outlive the entity it names.
CREATE TABLE directory_changes (
  account_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  entity_type TEXT NOT NULL,
  workspace_id TEXT,
  entity_id TEXT NOT NULL,
  at INTEGER NOT NULL,
  PRIMARY KEY (account_id, seq)
);

CREATE INDEX idx_directory_changes_at ON directory_changes (at);
