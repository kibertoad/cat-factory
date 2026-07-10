-- Estimate gating for the optional implementation-fork decision phase on the Coder step,
-- stored on the workspace merge threshold preset as a JSON `StepGating` blob (the same shape
-- as the consensus/step gating). Nullable: absent/disabled ⇒ fork surfacing is off in `auto`
-- mode. Mirrored on Node by the `fork_decision` jsonb column on the Drizzle
-- `merge_threshold_presets` table.
ALTER TABLE merge_threshold_presets ADD COLUMN fork_decision TEXT;
