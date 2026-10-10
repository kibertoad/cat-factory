-- The PRE-DISPATCH INPUT GATE's per-workspace mode: the deterministic structural check of a task's
-- authored input, run before a run's first agent step is dispatched so a task nobody could act on
-- parks having spent no tokens.
--
-- 'standard' (park on a blocking finding) | 'advisory' (record, never park) | 'off' (skip).
-- Defaulted to 'standard' rather than 'off', which makes every existing row valid WITH the gate
-- on: each blocking finding names an input a model could not have acted on either, so the gate
-- only ever replaces a review call that would have reported the same absence. Mirrors the Drizzle
-- column on workspace_settings.
ALTER TABLE workspace_settings ADD COLUMN input_gate_mode TEXT NOT NULL DEFAULT 'standard';
