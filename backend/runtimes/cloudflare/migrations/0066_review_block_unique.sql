-- One live review per block, enforced by the DATABASE (race-condition audit 2.5, follow-up).
--
-- Migration 0065 gave the review stores a `rev` + `compareAndSwap`, and the service publishes a
-- fresh review through an atomic replace. But "atomic" was carried by a transaction wrapping a
-- DELETE-then-INSERT, and a transaction is not a uniqueness constraint: under Postgres' default
-- READ COMMITTED a DELETE takes no predicate lock, so two review runs for one block both delete
-- nothing (or each other's already-gone row), both insert, and both commit — leaving TWO live
-- reviews, which is exactly the hazard the replace was introduced to close. SQLite serializes
-- writers so D1 happened to be safe; that is a runtime accident, not a guarantee, and the two
-- facades must not disagree about a domain invariant.
--
-- The invariant is therefore expressed where it belongs: a UNIQUE index on the block key. With it
-- the replace becomes a single conflict-targeted upsert (no delete, nothing to interleave) on both
-- runtimes, and any future writer that tries to add a second live review fails loudly instead of
-- silently splitting the block's review in two.
--
-- Self-healing, like every constraint-adding migration here: pre-existing duplicates (rows a
-- delete/insert pair already interleaved into existence) are deleted before the index is created,
-- newest `created_at` winning — the same row `getByBlock` returns today, so the surviving review is
-- the one the product is already showing. Dropping the superseded duplicates is correct: they were
-- never reachable.

DELETE FROM requirement_reviews
WHERE rowid NOT IN (
  SELECT rowid FROM requirement_reviews r
  WHERE r.rowid = (
    SELECT rowid FROM requirement_reviews x
    WHERE x.workspace_id = r.workspace_id AND x.block_id = r.block_id
    ORDER BY x.created_at DESC, x.rowid DESC
    LIMIT 1
  )
);
DROP INDEX IF EXISTS idx_requirement_reviews_block;
CREATE UNIQUE INDEX idx_requirement_reviews_block
  ON requirement_reviews (workspace_id, block_id);

DELETE FROM clarity_reviews
WHERE rowid NOT IN (
  SELECT rowid FROM clarity_reviews r
  WHERE r.rowid = (
    SELECT rowid FROM clarity_reviews x
    WHERE x.workspace_id = r.workspace_id AND x.block_id = r.block_id
    ORDER BY x.created_at DESC, x.rowid DESC
    LIMIT 1
  )
);
DROP INDEX IF EXISTS idx_clarity_reviews_block;
CREATE UNIQUE INDEX idx_clarity_reviews_block ON clarity_reviews (workspace_id, block_id);

-- Brainstorm is keyed by (block, stage): a block legitimately holds one live `requirements` and
-- one live `architecture` session at once, so the stage is part of the uniqueness key.
DELETE FROM brainstorm_sessions
WHERE rowid NOT IN (
  SELECT rowid FROM brainstorm_sessions r
  WHERE r.rowid = (
    SELECT rowid FROM brainstorm_sessions x
    WHERE x.workspace_id = r.workspace_id AND x.block_id = r.block_id AND x.stage = r.stage
    ORDER BY x.created_at DESC, x.rowid DESC
    LIMIT 1
  )
);
DROP INDEX IF EXISTS idx_brainstorm_sessions_block_stage;
CREATE UNIQUE INDEX idx_brainstorm_sessions_block_stage
  ON brainstorm_sessions (workspace_id, block_id, stage);
