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

-- 1. Materialise `mp_unattended` in every workspace that already has a library, from the same
--    catalog definition `RISK_POLICY_SEEDS` ships (Balanced's ceilings, `autonomy: 'unattended'`).
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
  d.workspace_id, 'mp_unattended', 'Unattended delivery', 0.5, 0.4, 0.5, 10,
  6, 'none', 3,
  30, 1, 10,
  0.7, 1, 1,
  '{"enabled":false,"minComplexity":0.5,"minRisk":0.4,"minImpact":0.4,"onMissingEstimate":"run"}',
  '{}',
  '{}', '[]', '{}', 1, 'unattended',
  0, 0, d.created_at + 1
FROM merge_threshold_presets d
WHERE d.is_default = 1;

-- 2. Name the unattended default, "unless configured differently": a workspace still sitting on
--    the shipped `mp_balanced` gets the new policy, and one whose operator moved the default onto
--    a policy of their own keeps THAT for unattended runs too. Landing authority never moves
--    underneath somebody who already stated theirs; all they gain is a run that no longer waits
--    on a person who is not there, which they opt into by re-pointing this flag.
UPDATE merge_threshold_presets
   SET is_unattended_default = 1
 WHERE id = 'mp_unattended'
   AND workspace_id IN (
     SELECT workspace_id FROM merge_threshold_presets WHERE is_default = 1 AND id = 'mp_balanced'
   );

UPDATE merge_threshold_presets
   SET is_unattended_default = 1
 WHERE is_default = 1
   AND id <> 'mp_balanced'
   AND workspace_id NOT IN (
     SELECT workspace_id FROM merge_threshold_presets WHERE is_unattended_default = 1
   );
