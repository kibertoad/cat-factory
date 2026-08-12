import { bigint, doublePrecision, integer, pgTable, primaryKey, text } from 'drizzle-orm/pg-core'

// ---------------------------------------------------------------------------
// The ACCOUNT tier of the risk-policy library, and which of its policies a BOARD hides (ADR 0055),
// mirroring the Cloudflare D1 tables (migration 0092) column-for-column exactly as the rest of the
// Node schema does.
//
// One cohesive group, split out of `../schema.ts` so that module stays within its size budget. The
// board's OWN policies (`merge_threshold_presets`) deliberately stay there, beside the merge track
// record they are judged against: they are board-lifecycle state (seeded from the built-in catalog at
// creation, reclaimed by the board-delete cascade) where these two are not.
//
// The tier merge itself is kernel's `mergeRiskPolicyTiers`, shared by both facades, so neither of
// these tables encodes any precedence of its own.
// ---------------------------------------------------------------------------

/**
 * Risk policies authored once for a whole account, which every board under it inherits read-only and
 * may clone or hide.
 *
 * Column-for-column the same as `merge_threshold_presets` MINUS the two per-scope DEFAULT claims:
 * which policy governs a task that pinned none is a per-BOARD question, so no account row may hold
 * it (the account write door refuses the flags rather than dropping them).
 */
export const accountRiskPolicies = pgTable(
  'account_risk_policies',
  {
    account_id: text('account_id').notNull(),
    id: text('id').notNull(),
    name: text('name').notNull(),
    max_complexity: doublePrecision('max_complexity').notNull(),
    max_risk: doublePrecision('max_risk').notNull(),
    max_impact: doublePrecision('max_impact').notNull(),
    ci_max_attempts: integer('ci_max_attempts').notNull(),
    max_requirement_iterations: integer('max_requirement_iterations').notNull().default(3),
    max_requirement_concern_allowed: text('max_requirement_concern_allowed')
      .notNull()
      .default('none'),
    max_tester_quality_iterations: integer('max_tester_quality_iterations').notNull().default(3),
    release_watch_window_minutes: integer('release_watch_window_minutes').notNull().default(30),
    release_max_attempts: integer('release_max_attempts').notNull().default(1),
    human_review_grace_minutes: integer('human_review_grace_minutes').notNull().default(10),
    judge_min_score: doublePrecision('judge_min_score').notNull().default(0.7),
    judge_max_bounces: integer('judge_max_bounces').notNull().default(1),
    auto_merge_enabled: integer('auto_merge_enabled').notNull().default(1),
    fork_decision: text('fork_decision'),
    class_rules: text('class_rules').notNull().default('{}'),
    class_rules_by_role: text('class_rules_by_role').notNull().default('{}'),
    dry_run_roles: text('dry_run_roles').notNull().default('[]'),
    submission_classes_by_role: text('submission_classes_by_role').notNull().default('{}'),
    // Unused by this tier (the built-in catalog is copied into BOARDS, so there is nothing here to
    // reseed), kept so the two tiers' row shapes stay identical and a clone can copy field-for-field.
    version: integer('version'),
    autonomy: text('autonomy').notNull().default('attended'),
    min_auto_answer_confidence: doublePrecision('min_auto_answer_confidence')
      .notNull()
      .default(0.8),
    created_at: bigint('created_at', { mode: 'number' }).notNull(),
  },
  (t) => [primaryKey({ columns: [t.account_id, t.id] })],
)

/**
 * One row per account policy a BOARD hides, so the policy loses the tier merge and no task on that
 * board can pin it.
 *
 * Deliberately NOT foreign-keyed to {@link accountRiskPolicies}: a suppression outliving the policy
 * it named is a real state the editor reports as "hides nothing", and a cascade would silently
 * un-hide a posture if an account withdrew and re-authored a policy under the same id.
 */
export const riskPolicySuppressions = pgTable(
  'risk_policy_suppressions',
  {
    workspace_id: text('workspace_id').notNull(),
    policy_id: text('policy_id').notNull(),
    created_at: bigint('created_at', { mode: 'number' }).notNull(),
  },
  (t) => [primaryKey({ columns: [t.workspace_id, t.policy_id] })],
)
