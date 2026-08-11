ALTER TABLE "merge_threshold_presets" ADD COLUMN "autonomy" text DEFAULT 'attended' NOT NULL;--> statement-breakpoint
ALTER TABLE "merge_threshold_presets" ADD COLUMN "is_unattended_default" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
CREATE INDEX "idx_merge_presets_unattended_default" ON "merge_threshold_presets" ("workspace_id","is_unattended_default");--> statement-breakpoint
-- The BACKFILL, mirroring D1 migration 0090 statement for statement. It is the load-bearing half:
-- a scope with no default resolves `FALLBACK_RISK_POLICY`, which auto-merges nothing, so shipping
-- the column without filling it would silently stop every API-started task in every existing
-- workspace from landing.
--
-- 1. Materialise `mp_unattended` in every workspace that already has a library, from the same
--    catalog definition `RISK_POLICY_SEEDS` ships. `ON CONFLICT DO NOTHING`: a workspace that
--    somehow already holds the id keeps whatever an operator put there.
INSERT INTO "merge_threshold_presets" (
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
FROM "merge_threshold_presets" d
WHERE d.is_default = 1
ON CONFLICT (workspace_id, id) DO NOTHING;--> statement-breakpoint
-- 2. Name the unattended default, "unless configured differently": a workspace still sitting on
--    the shipped `mp_balanced` gets the new policy, and one whose operator moved the default onto
--    a policy of their own keeps THAT for unattended runs too.
UPDATE "merge_threshold_presets"
   SET is_unattended_default = 1
 WHERE id = 'mp_unattended'
   AND workspace_id IN (
     SELECT workspace_id FROM "merge_threshold_presets" WHERE is_default = 1 AND id = 'mp_balanced'
   );--> statement-breakpoint
UPDATE "merge_threshold_presets"
   SET is_unattended_default = 1
 WHERE is_default = 1
   AND id <> 'mp_balanced'
   AND workspace_id NOT IN (
     SELECT workspace_id FROM "merge_threshold_presets" WHERE is_unattended_default = 1
   );
