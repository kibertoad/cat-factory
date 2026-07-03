-- Initiatives: the long-running multi-task work container (see
-- docs/initiatives/initiatives-feature.md). One row per `initiative`-level block;
-- the whole entity (phases/items/policy/decisions/…) lives in the `doc` JSON blob,
-- with the loop-relevant keys (status, rev) lifted into columns. `rev` is the
-- optimistic-concurrency token every post-insert write CAS-es on, making the
-- execution loop a single logical writer.
CREATE TABLE initiatives (
  workspace_id TEXT NOT NULL,
  id TEXT NOT NULL,
  block_id TEXT NOT NULL,
  slug TEXT NOT NULL,
  status TEXT NOT NULL,
  rev INTEGER NOT NULL,
  doc TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (workspace_id, id),
  UNIQUE (workspace_id, block_id)
);

-- The cron sweeper's work list (slice 3): every `executing` initiative across all
-- workspaces.
CREATE INDEX idx_initiatives_status ON initiatives (status);

-- A task spawned by an initiative's execution loop carries the initiative BLOCK id
-- here (epic-style membership, independent of parent_id). NULL ⇒ not initiative work.
ALTER TABLE blocks ADD COLUMN initiative_id TEXT;
CREATE INDEX idx_blocks_initiative ON blocks (workspace_id, initiative_id);
