-- Headless clarification loop, slice 2a: questions out to the linked tracker issue.
-- See backend/docs/adr/0047-headless-clarification-loop.md.
--
-- When a run started through the public API parks its requirements review on open findings,
-- the engine echoes those findings — each with its stable id — onto the block's linked tracker
-- issue(s), so the caller can answer from where the work was requested. Opt-in per workspace
-- (`writeback_questions_on_park`) with the usual per-task override on the block.
ALTER TABLE tracker_settings ADD COLUMN writeback_questions_on_park INTEGER NOT NULL DEFAULT 0;
ALTER TABLE blocks ADD COLUMN tracker_questions_on_park TEXT;

-- Idempotency marker: one row per (workspace, review, iteration, linked issue). The post is
-- driven from the DURABLE driver, whose steps replay, so without this every replay of a parked
-- gate step would re-post the same findings onto the issue a human is reading. The row is
-- CLAIMED before the comment is attempted (an insert-or-conditionally-update), so a crash
-- between the post and the marker write cannot double-post either.
--
-- A `failed` row is deliberately re-claimable — a tracker outage should be retried on the next
-- replay — while `posted` is terminal for that iteration. `error` keeps the last failure so an
-- operator can see WHY an issue never received its questions.
CREATE TABLE review_question_posts (
  workspace_id TEXT NOT NULL,
  review_id TEXT NOT NULL,
  iteration INTEGER NOT NULL,
  issue_ref TEXT NOT NULL,
  status TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (workspace_id, review_id, iteration, issue_ref)
);
