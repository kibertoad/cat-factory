-- Requirements-review feature: a stateless reviewer agent raises questions /
-- gaps / clarifications about a board block's collected requirements, humans
-- answer or dismiss each, and the agent folds the answers back into the block's
-- description. Unlike executions/bootstraps this flow is synchronous and has no
-- durable driver, so it gets its own small table rather than a row in agent_runs.
--
-- At most one *live* review per block: the service deletes the block's prior
-- review before inserting a fresh one, so `block_id` effectively identifies the
-- current review. `items` holds the JSON-serialized array of review items
-- (id/category/severity/title/detail/status/reply/timestamps).

CREATE TABLE requirement_reviews (
  workspace_id              TEXT    NOT NULL,
  id                        TEXT    NOT NULL,
  block_id                  TEXT    NOT NULL,
  status                    TEXT    NOT NULL,              -- 'ready' | 'incorporated'
  items                     TEXT    NOT NULL DEFAULT '[]', -- JSON array of review items
  model                     TEXT,                          -- 'provider:model' that produced it
  incorporated_requirements TEXT,                          -- revised requirements after incorporation
  created_at                INTEGER NOT NULL,
  updated_at                INTEGER NOT NULL,
  PRIMARY KEY (workspace_id, id)
);

CREATE INDEX idx_requirement_reviews_block ON requirement_reviews (workspace_id, block_id);
