ALTER TABLE "merge_threshold_presets" ADD COLUMN "autonomy" text DEFAULT 'attended' NOT NULL;--> statement-breakpoint
ALTER TABLE "merge_threshold_presets" ADD COLUMN "is_unattended_default" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
CREATE INDEX "idx_merge_presets_unattended_default" ON "merge_threshold_presets" ("workspace_id","is_unattended_default");--> statement-breakpoint
-- The BACKFILL, mirroring D1 migration 0090 statement for statement. It is the load-bearing half:
-- a scope with no default resolves `FALLBACK_RISK_POLICY`, which auto-merges nothing, so shipping
-- the column without filling it would silently stop every API-started task in every existing
-- workspace from landing.
--
-- 1. Materialise `mp_unattended` in every workspace that already has a library, CLONED FROM THAT
--    WORKSPACE'S OWN DEFAULT with the single field this feature is about flipped. A built-in is
--    editable IN PLACE, so a row's id says nothing about whether its ceilings are still the ones
--    we shipped; inheriting them (and the per-role `dry_run_roles` /
--    `submission_classes_by_role`, which ARE the landing authority) is what stops an operator who
--    tightened their default from having every API-started run land on stock ceilings instead.
--    `ON CONFLICT DO NOTHING`: a workspace that somehow already holds the id keeps whatever an
--    operator put there.
INSERT INTO "merge_threshold_presets" (
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
FROM "merge_threshold_presets" d
WHERE d.is_default = 1
ON CONFLICT (workspace_id, id) DO NOTHING;--> statement-breakpoint
-- 2. A workspace that ALREADY held `mp_unattended` kept its own row above and so never took the
--    flag with it. Name that row the unattended default, but only where the workspace still has
--    none, so this can never demote a flag step 1 just set.
UPDATE "merge_threshold_presets"
   SET is_unattended_default = 1
 WHERE id = 'mp_unattended'
   AND workspace_id NOT IN (
     SELECT workspace_id FROM "merge_threshold_presets" WHERE is_unattended_default = 1
   );
