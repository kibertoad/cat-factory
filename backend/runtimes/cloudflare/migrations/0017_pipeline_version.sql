-- Per-pipeline seed version, so a workspace's persisted built-in copy can be compared
-- against the current catalog (`seedPipelines()`) and offered a reseed when the catalog
-- definition moves ahead.
--
-- `pipelines.version` — monotonic integer for a built-in pipeline; NULL on user-created /
--                       cloned pipelines (not version-tracked) and on rows persisted before
--                       this column existed (the app treats NULL as 0, so they read as
--                       "update available" once).

ALTER TABLE pipelines ADD COLUMN version INTEGER;
