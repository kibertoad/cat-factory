-- The companion REWORK budget, on both risk-policy tiers.
--
-- A companion (`reviewer`, `architect-companion`, `spec-companion`, or one a deployment
-- registered) that rates its producer below the bar sends that step back with the findings and
-- re-grades the result. How many times it may do that unasked was the one automatic-loop budget the
-- engine hard-coded (3, in `DEFAULT_COMPANION_MAX_ATTEMPTS`) while every sibling loop — the CI
-- fixer, the iterative requirements review, the Tester quality gate, a judge's bounces, the
-- post-release-health watch — reads its ceiling off the task's risk policy. So the loop with the
-- widest reach, and the one an operator watching a run actually sees spend model calls, was the one
-- they could not tune.
--
-- `companion_max_reworks` — how many automatic rework rounds a companion may drive before it stops
--                           grading and parks for a person to pick (one more round / proceed anyway
--                           / stop and reset). `0` is a real posture, not a disabled feature: the
--                           first verdict below the bar goes straight to that park, or straight to
--                           `proceed` under `autonomy = 'unattended'`. A human-granted extra round
--                           raises the STEP's own budget, so this caps what the platform spends
--                           unasked and never what somebody asks for.
--
-- The default is the ceiling the engine held, so every stored policy keeps the behaviour it had and
-- no built-in seed needed a version bump to announce this: a freshly seeded row and a backfilled one
-- are byte-for-byte identical.

ALTER TABLE merge_threshold_presets
  ADD COLUMN companion_max_reworks INTEGER NOT NULL DEFAULT 3;

ALTER TABLE account_risk_policies
  ADD COLUMN companion_max_reworks INTEGER NOT NULL DEFAULT 3;
