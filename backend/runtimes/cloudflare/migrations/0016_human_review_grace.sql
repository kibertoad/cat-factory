-- Human-review gate: per-task grace window (minutes) the gate waits after the latest review
-- comment before dispatching the `fixer` to address the batch. Mirrors the Node Drizzle column
-- (keep the runtimes symmetric). Default 10 matches DEFAULT_MERGE_PRESET.humanReviewGraceMinutes.
ALTER TABLE merge_threshold_presets
  ADD COLUMN human_review_grace_minutes INTEGER NOT NULL DEFAULT 10;
