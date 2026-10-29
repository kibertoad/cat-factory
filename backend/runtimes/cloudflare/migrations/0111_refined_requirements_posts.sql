-- Idempotency marker for posting a requirements review's refined document onto the block's linked
-- tracker issue(s) as a comment: one row per (workspace, review, linked issue, document hash). The
-- row is CLAIMED before the comment is attempted, so a double click, a retried request or two
-- people clicking at once cannot leave two copies of the document on an issue. A revised document
-- has a different hash and is a new post.
--
-- `failed` is re-claimable (posting again retries a tracker outage), `posted` is terminal, and a
-- `pending` row becomes re-claimable once abandoned. `error` keeps the last scrubbed failure.
CREATE TABLE refined_requirements_posts (
  workspace_id TEXT NOT NULL,
  review_id TEXT NOT NULL,
  issue_ref TEXT NOT NULL,
  document_hash TEXT NOT NULL,
  status TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (workspace_id, review_id, issue_ref, document_hash)
);
