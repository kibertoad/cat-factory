-- A workspace's SECOND default risk policy: the one that governs a run nothing is watching (the
-- public API, a tracker dispatch, a schedule fire), plus the `autonomy` posture that says whether
-- such a run answers the parks its own automatic loops raise instead of stopping for a person.
--
-- Two columns and a backfill, mirrored by the `autonomy` / `is_unattended_default` columns on the
-- Drizzle `merge_threshold_presets` table.
--
-- The BACKFILL is the load-bearing half, because a scope with no default resolves
-- `FALLBACK_RISK_POLICY`, which auto-merges nothing: shipping the column without filling it would
-- silently stop every API-started task in every existing workspace from landing. So every existing
-- library gains the new built-in AND names an unattended default, in the two steps below.

ALTER TABLE merge_threshold_presets ADD COLUMN autonomy TEXT NOT NULL DEFAULT 'attended';
ALTER TABLE merge_threshold_presets ADD COLUMN is_unattended_default INTEGER NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_merge_presets_unattended_default
  ON merge_threshold_presets (workspace_id, is_unattended_default);

-- 1. Materialise `mp_unattended` in every workspace that already has a library, CLONED FROM THAT
--    WORKSPACE'S OWN DEFAULT with the single field this feature is about flipped.
--
--    Cloning, rather than writing the catalog's stock values, is what keeps the promise that
--    landing authority never moves underneath an operator who has already stated theirs. A
--    built-in is editable IN PLACE, so a row's id says nothing about whether its ceilings are
--    still the ones we shipped: a workspace that tightened its `Balanced` down to
--    `maxRisk: 0.1, autoMergeEnabled: 0` keeps `id = 'mp_balanced'`, and seeding stock ceilings
--    beside it would hand every API-started run a wider licence to land than the operator's own
--    default grants. Every ceiling, budget and per-role restriction is inherited here
--    (`dry_run_roles` and `submission_classes_by_role` above all, being the role-scoped landing
--    authority itself); the ONLY difference from the row it clones is `autonomy`, so all the
--    workspace gains is a run that stops waiting on a person who is not there.
--
--    `INSERT OR IGNORE` rather than an upsert: a workspace that somehow already holds the id keeps
--    whatever an operator put there.
INSERT OR IGNORE INTO merge_threshold_presets (
  workspace_id, id, name, max_complexity, max_risk, max_impact, ci_max_attempts,
  max_requirement_iterations, max_requirement_concern_allowed, max_tester_quality_iterations,
  release_watch_window_minutes, release_max_attempts, human_review_grace_minutes,
  judge_min_score, judge_max_bounces, auto_merge_enabled, fork_decision, class_rules,
  class_rules_by_role, dry_run_roles, submission_classes_by_role, version, autonomy,
  is_default, is_unattended_default, created_at
)
SELECT
  d.workspace_id, 'mp_unattended', 'Unattended delivery',
  d.max_complexity, d.max_risk, d.max_impact, d.ci_max_attempts,
  d.max_requirement_iterations, d.max_requirement_concern_allowed, d.max_tester_quality_iterations,
  d.release_watch_window_minutes, d.release_max_attempts, d.human_review_grace_minutes,
  d.judge_min_score, d.judge_max_bounces, d.auto_merge_enabled, d.fork_decision, d.class_rules,
  d.class_rules_by_role, d.dry_run_roles, d.submission_classes_by_role, 1, 'unattended',
  0, 1, d.created_at + 1
FROM merge_threshold_presets d
WHERE d.is_default = 1;

-- 2. A workspace that ALREADY held `mp_unattended` kept its own row above and so never took the
--    flag with it. Name that row the unattended default, but only where the workspace still has
--    none, so this can never demote a flag step 1 just set.
UPDATE merge_threshold_presets
   SET is_unattended_default = 1
 WHERE id = 'mp_unattended'
   AND workspace_id NOT IN (
     SELECT workspace_id FROM merge_threshold_presets WHERE is_unattended_default = 1
   );
