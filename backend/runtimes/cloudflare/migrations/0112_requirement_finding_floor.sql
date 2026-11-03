-- How verbose a requirements review is: the lowest severity the reviewer raises, on both risk
-- policy tiers, and what each review pass raised against.

-- `medium` raises `high` and `medium` findings and drops `low` ones. `requirement_floor_progression`
-- is JSON (`{ "mediumFrom": n, "lowFrom": n }`) when the floor follows the task estimate, NULL when
-- it is fixed.
ALTER TABLE merge_threshold_presets
  ADD COLUMN requirement_finding_floor TEXT NOT NULL DEFAULT 'medium';
ALTER TABLE merge_threshold_presets ADD COLUMN requirement_floor_progression TEXT;

ALTER TABLE account_risk_policies
  ADD COLUMN requirement_finding_floor TEXT NOT NULL DEFAULT 'medium';
ALTER TABLE account_risk_policies ADD COLUMN requirement_floor_progression TEXT;

-- The floor the latest reviewer pass resolved (JSON: severity, basis, score, suppressed count).
-- NULL on a review written before this column existed.
ALTER TABLE requirement_reviews ADD COLUMN finding_floor TEXT;
