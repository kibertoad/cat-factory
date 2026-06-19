-- Task run-configuration cleanup.
--
-- Drop the legacy per-task fields that no longer have a UI or an engine role:
--   * confidence_threshold — the old confidence-based auto-merge gate, replaced by
--     the merge_threshold_presets policy the `merger` step evaluates.
--   * features          — task-level "features implemented" tracking; the board /
--     service map now tracks services and modules only.
-- Add the task's chosen default pipeline (picked at creation), parallel to
-- merge_preset_id; null means no pinned pipeline.
ALTER TABLE blocks DROP COLUMN confidence_threshold;
ALTER TABLE blocks DROP COLUMN features;
ALTER TABLE blocks ADD COLUMN pipeline_id TEXT;
