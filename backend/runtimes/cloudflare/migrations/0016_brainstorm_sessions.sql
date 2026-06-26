-- Brainstorm (structured-dialogue) sessions. The brainstorm analogue of `clarity_reviews`:
-- items as a JSON array, the converged direction in `converged_direction`. Unlike the review
-- tables it is keyed per (block, STAGE) — a block may have one live `requirements` session and
-- one live `architecture` session at once — so the block index includes the stage.
CREATE TABLE brainstorm_sessions (
  workspace_id        TEXT    NOT NULL,
  id                  TEXT    NOT NULL,
  block_id            TEXT    NOT NULL,
  stage               TEXT    NOT NULL,
  status              TEXT    NOT NULL,
  items               TEXT    NOT NULL DEFAULT '[]',
  model               TEXT,
  converged_direction TEXT,
  iteration           INTEGER NOT NULL DEFAULT 1,
  max_iterations      INTEGER NOT NULL DEFAULT 1,
  created_at          INTEGER NOT NULL,
  updated_at          INTEGER NOT NULL,
  PRIMARY KEY (workspace_id, id)
);
CREATE INDEX idx_brainstorm_sessions_block_stage
  ON brainstorm_sessions (workspace_id, block_id, stage);
