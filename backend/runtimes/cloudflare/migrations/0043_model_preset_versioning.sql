-- Model-preset versioning.
--
-- `version` is the monotonic catalog version for a BUILT-IN model preset
-- (`seedModelPresets()`), so the SPA can detect a stale persisted copy and offer a
-- reseed. NULL on user-created presets (not version-tracked) and on rows persisted
-- before this column existed (the app treats NULL as 0).
ALTER TABLE model_presets
  ADD COLUMN version INTEGER;
