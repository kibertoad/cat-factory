-- Iterative requirements-review loop + per-task knobs.
--
-- The rework quality-companion gate is removed (convergence is now reviewer-driven), so
-- `requirement_reviews` drops `companion` and gains a reviewer-pass counter + its budget
-- (`iteration` / `max_iterations`). `merge_threshold_presets` gains the two per-task knobs
-- that drive the loop: how many reviewer passes to run before asking the human, and the
-- finding severity tolerated without stopping. Per the pre-1.0 no-backwards-compat policy
-- there is NO backfill: existing review rows are re-created by the next run.

ALTER TABLE requirement_reviews DROP COLUMN companion;
ALTER TABLE requirement_reviews ADD COLUMN iteration      INTEGER NOT NULL DEFAULT 1;
ALTER TABLE requirement_reviews ADD COLUMN max_iterations INTEGER NOT NULL DEFAULT 1;

ALTER TABLE merge_threshold_presets
  ADD COLUMN max_requirement_iterations      INTEGER NOT NULL DEFAULT 3;
ALTER TABLE merge_threshold_presets
  ADD COLUMN max_requirement_concern_allowed TEXT    NOT NULL DEFAULT 'none';
