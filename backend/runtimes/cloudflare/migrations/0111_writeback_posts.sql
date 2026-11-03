-- One exactly-once marker for every tracker writeback that must not post twice, keyed
-- (workspace, kind, subject, linked issue, discriminator). It replaces `review_question_posts`
-- (kind `review_questions`: subject = review id, discriminator = iteration) and also serves the
-- refined-requirements post (kind `refined_requirements`: subject = review id, discriminator =
-- SHA-256 of the posted document).
--
-- The row is CLAIMED before the comment is attempted. `claim_token` is minted by each claim, so the
-- claiming statement can tell the caller whether it won (its own token came back) or what holds the
-- row, in one round trip. `failed` is re-claimable, `posted` is terminal, and a `pending` row is
-- re-taken only when the caller passes an abandonment cutoff.
CREATE TABLE writeback_posts (
  workspace_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  subject_id TEXT NOT NULL,
  issue_ref TEXT NOT NULL,
  discriminator TEXT NOT NULL,
  status TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  claim_token TEXT,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (workspace_id, kind, subject_id, issue_ref, discriminator)
);

-- Carry the question markers over, so a parked review that already posted its questions does not
-- post them again on its next replay.
INSERT INTO writeback_posts
  (workspace_id, kind, subject_id, issue_ref, discriminator, status, attempts, error, claim_token,
   updated_at)
SELECT workspace_id, 'review_questions', review_id, issue_ref, CAST(iteration AS TEXT), status,
       attempts, error, NULL, updated_at
FROM review_question_posts;

DROP TABLE review_question_posts;
