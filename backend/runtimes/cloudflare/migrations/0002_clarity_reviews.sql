-- Clarity (bug-report triage) reviews. The mirror of `requirement_reviews`: one row per
-- review, items as a JSON array, at most one live review per block. The persisted document
-- is the clarified bug report (`clarified_report`), the clarity analogue of the
-- requirements review's `incorporated_requirements`.
CREATE TABLE clarity_reviews (
  workspace_id     TEXT    NOT NULL,
  id               TEXT    NOT NULL,
  block_id         TEXT    NOT NULL,
  status           TEXT    NOT NULL,
  items            TEXT    NOT NULL DEFAULT '[]',
  model            TEXT,
  clarified_report TEXT,
  iteration        INTEGER NOT NULL DEFAULT 1,
  max_iterations   INTEGER NOT NULL DEFAULT 1,
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL,
  PRIMARY KEY (workspace_id, id)
);
CREATE INDEX idx_clarity_reviews_block ON clarity_reviews (workspace_id, block_id);
