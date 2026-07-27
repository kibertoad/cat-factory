-- Tracker webhook intake, slice 3: issue-comment answers to a parked requirements review.
-- See docs/initiatives/tracker-webhook-intake.md.
--
-- Idempotency marker for an INBOUND tracker comment: one row per
-- (workspace, source, external_id, comment_id). Every tracker redelivers — each vendor retries a
-- delivery the receiver failed to ack, an async queue job is retried on any error, and the polling
-- sweep can overlap a live delivery — so without this one reporter comment would answer the same
-- finding several times, each answer re-entering the incorporation prompt as if the human had said
-- it twice.
--
-- The row is CLAIMED before the commands are applied (an insert-or-conditionally-update), so a
-- crash between applying an answer and writing the marker cannot re-apply on the next delivery.
-- A `failed` row is re-claimable (a transient failure should be retried); `applied` is terminal;
-- a `pending` one is re-claimable only once ABANDONED, so an ingester killed mid-apply does not
-- silence that comment forever. `error` keeps the last failure, scrubbed, for an operator.
--
-- Mirrors the `review_question_posts` marker deliberately — same claim shape, same reasoning.
CREATE TABLE tracker_comment_ingests (
  workspace_id TEXT NOT NULL,
  source TEXT NOT NULL,
  external_id TEXT NOT NULL,
  comment_id TEXT NOT NULL,
  status TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (workspace_id, source, external_id, comment_id)
);
