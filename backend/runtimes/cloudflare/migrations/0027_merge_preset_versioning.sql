-- Merge-preset versioning + the auto-merge kill switch.
--
-- `auto_merge_enabled` lets a preset disable auto-merge outright (the built-in
-- "Manual review only" preset, and any custom preset that opts in): the `merger`
-- step then routes every PR to a human review instead of auto-merging. Defaults to
-- 1 (the historical behaviour: auto-merge a within-threshold, explained assessment).
--
-- `version` is the monotonic catalog version for a BUILT-IN preset (`seedMergePresets()`),
-- so the SPA can detect a stale persisted copy and offer a reseed. NULL on user-created
-- presets (not version-tracked) and on rows persisted before this column existed (the
-- app treats NULL as 0).
ALTER TABLE merge_threshold_presets
  ADD COLUMN auto_merge_enabled INTEGER NOT NULL DEFAULT 1;
ALTER TABLE merge_threshold_presets
  ADD COLUMN version INTEGER;
