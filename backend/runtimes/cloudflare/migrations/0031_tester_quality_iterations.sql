-- Test quality-control companion: per-preset budget for how many times the QC companion
-- may loop the Tester for a more complete report before letting the run proceed to the
-- greenlight / fixer decision. Default 3, matching DEFAULT_MERGE_PRESET.
ALTER TABLE merge_threshold_presets
  ADD COLUMN max_tester_quality_iterations INTEGER NOT NULL DEFAULT 3;
