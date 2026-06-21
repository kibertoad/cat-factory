-- Per-step companion quality thresholds for a saved pipeline, parallel to
-- `agent_kinds` (a JSON array of `number | null`). Only meaningful on companion
-- steps; null/absent entries mean "use the companion's default threshold". Mirrors
-- the `gates` column added in migration 0022.
ALTER TABLE pipelines ADD COLUMN thresholds TEXT;
