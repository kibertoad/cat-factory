-- Judge steps (the fourth step-taxonomy bucket — see `docs/initiatives/judge-registry.md`).
-- Two per-task knobs on the merge threshold preset, mirroring the Drizzle/Postgres columns
-- (keep the runtimes symmetric):
--   * judge_min_score   — the minimum verdict score (0..1) a rubric assessment must reach for
--                         the run to advance without a human. Default 0.7 matches
--                         DEFAULT_RISK_POLICY.judgeMinScore.
--   * judge_max_bounces — how many rework BOUNCE rounds a judge may spend (re-arming the
--                         preceding producing step with the verdict's findings) before it must
--                         ask a human. Default 1 matches DEFAULT_RISK_POLICY.judgeMaxBounces.
ALTER TABLE merge_threshold_presets ADD COLUMN judge_min_score REAL NOT NULL DEFAULT 0.7;
ALTER TABLE merge_threshold_presets ADD COLUMN judge_max_bounces INTEGER NOT NULL DEFAULT 1;
