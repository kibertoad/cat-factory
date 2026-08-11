import type { RiskPolicyRepository } from '@cat-factory/kernel'
import type {
  ClassRulesByRole,
  MergeClassRules,
  RiskPolicy,
  RiskPolicyDefaultScope,
  RequirementConcernLevel,
  StepGating,
  SubmissionClassesByRole,
  WorkspaceRole,
} from '@cat-factory/contracts'
import type { D1Database } from '@cloudflare/workers-types'

interface RiskPolicyRow {
  id: string
  name: string
  max_complexity: number
  max_risk: number
  max_impact: number
  ci_max_attempts: number
  max_requirement_iterations: number
  max_requirement_concern_allowed: string
  max_tester_quality_iterations: number
  release_watch_window_minutes: number
  release_max_attempts: number
  human_review_grace_minutes: number
  judge_min_score: number
  judge_max_bounces: number
  auto_merge_enabled: number
  fork_decision: string | null
  class_rules: string | null
  class_rules_by_role: string | null
  dry_run_roles: string | null
  submission_classes_by_role: string | null
  version: number | null
  autonomy: string | null
  is_default: number
  is_unattended_default: number
  created_at: number
}

function rowToPreset(row: RiskPolicyRow): RiskPolicy {
  return {
    id: row.id,
    name: row.name,
    maxComplexity: row.max_complexity,
    maxRisk: row.max_risk,
    maxImpact: row.max_impact,
    ciMaxAttempts: row.ci_max_attempts,
    maxRequirementIterations: row.max_requirement_iterations,
    maxRequirementConcernAllowed: row.max_requirement_concern_allowed as RequirementConcernLevel,
    maxTesterQualityIterations: row.max_tester_quality_iterations,
    releaseWatchWindowMinutes: row.release_watch_window_minutes,
    releaseMaxAttempts: row.release_max_attempts,
    humanReviewGraceMinutes: row.human_review_grace_minutes,
    judgeMinScore: row.judge_min_score,
    judgeMaxBounces: row.judge_max_bounces,
    autoMergeEnabled: row.auto_merge_enabled === 1,
    forkDecision: row.fork_decision ? (JSON.parse(row.fork_decision) as StepGating) : null,
    // The column is NOT NULL DEFAULT '{}', but tolerate a null defensively: an empty rule map is
    // the identity (every class falls back to the score ceilings).
    classRules: row.class_rules ? (JSON.parse(row.class_rules) as MergeClassRules) : {},
    // Both columns are NOT NULL DEFAULT '{}' / '[]', but tolerate a null as above: the empty
    // value is the identity for each (no role narrows anything, nobody is sandboxed).
    classRulesByRole: row.class_rules_by_role
      ? (JSON.parse(row.class_rules_by_role) as ClassRulesByRole)
      : {},
    dryRunRoles: row.dry_run_roles ? (JSON.parse(row.dry_run_roles) as WorkspaceRole[]) : [],
    // Same defensive read again, and the same identity: `{}` scopes no role, so a preset that
    // predates the allowlist lands exactly what it always did.
    submissionClassesByRole: row.submission_classes_by_role
      ? (JSON.parse(row.submission_classes_by_role) as SubmissionClassesByRole)
      : {},
    // The column is NOT NULL DEFAULT 'attended', and the value is narrowed rather than cast for
    // the reason every closed persisted vocabulary is: a row written under a member later retired
    // must not be read back as that member. Anything unrecognised is `attended`, which is the
    // posture that stops for a person — never a licence this row cannot be shown to have granted.
    autonomy: row.autonomy === 'unattended' ? 'unattended' : 'attended',
    isDefault: row.is_default === 1,
    isUnattendedDefault: row.is_unattended_default === 1,
    ...(row.version != null ? { version: row.version } : {}),
    createdAt: row.created_at,
  }
}

/** The column one default scope is stored in; the ONE place that mapping lives on this facade. */
const DEFAULT_COLUMN: Record<RiskPolicyDefaultScope, 'is_default' | 'is_unattended_default'> = {
  interactive: 'is_default',
  unattended: 'is_unattended_default',
}

/**
 * Merge threshold presets, one row per preset in `merge_threshold_presets`
 * (migration 0024, the second default scope added by 0090). Enforces the single-default invariant
 * PER SCOPE: promoting a preset to one of the two defaults demotes every other holder of THAT flag
 * in the workspace, in one statement before the upsert, leaving the other scope alone. Neither
 * scope's default can be removed (the service keeps that rule too).
 */
export class D1RiskPolicyRepository implements RiskPolicyRepository {
  private readonly db: D1Database

  constructor({ db }: { db: D1Database }) {
    this.db = db
  }

  async get(workspaceId: string, id: string): Promise<RiskPolicy | null> {
    const row = await this.db
      .prepare(`SELECT * FROM merge_threshold_presets WHERE workspace_id = ? AND id = ?`)
      .bind(workspaceId, id)
      .first<RiskPolicyRow>()
    return row ? rowToPreset(row) : null
  }

  async list(workspaceId: string): Promise<RiskPolicy[]> {
    const { results } = await this.db
      .prepare(
        `SELECT * FROM merge_threshold_presets WHERE workspace_id = ? ORDER BY created_at ASC`,
      )
      .bind(workspaceId)
      .all<RiskPolicyRow>()
    return results.map(rowToPreset)
  }

  async getDefault(workspaceId: string, scope: RiskPolicyDefaultScope): Promise<RiskPolicy | null> {
    // The column name is interpolated from a `Record` over a CLOSED picklist, never from a caller
    // string: there is no value of `scope` the type admits that is not one of the two literals.
    const row = await this.db
      .prepare(
        `SELECT * FROM merge_threshold_presets
           WHERE workspace_id = ? AND ${DEFAULT_COLUMN[scope]} = 1
           ORDER BY created_at ASC LIMIT 1`,
      )
      .bind(workspaceId)
      .first<RiskPolicyRow>()
    return row ? rowToPreset(row) : null
  }

  async upsert(workspaceId: string, preset: RiskPolicy): Promise<void> {
    // Promoting this preset to a default demotes any other holder of THAT flag first, so the
    // single-default invariant holds per scope. Separate statements rather than one, because the
    // flags are independent: promoting the unattended default must leave the in-app one alone.
    //
    // ONE `batch`, which D1 runs as a single implicit transaction, mirroring the Drizzle
    // repository's explicit `db.transaction`. Run loose, a demote that committed before a failed
    // INSERT (a D1 error, an isolate eviction between the two awaits) would leave the workspace
    // with NO row holding that flag — `getDefault` then returns null and every run of that scope
    // silently falls to `FALLBACK_RISK_POLICY`, which auto-merges nothing. The two facades claim
    // to be behaviourally identical, and a partial-failure state only one of them can reach is
    // exactly the drift that claim exists to prevent.
    const demotions = [
      ...(preset.isDefault
        ? [
            this.db
              .prepare(
                `UPDATE merge_threshold_presets SET is_default = 0
                   WHERE workspace_id = ? AND id <> ?`,
              )
              .bind(workspaceId, preset.id),
          ]
        : []),
      ...(preset.isUnattendedDefault
        ? [
            this.db
              .prepare(
                `UPDATE merge_threshold_presets SET is_unattended_default = 0
                   WHERE workspace_id = ? AND id <> ?`,
              )
              .bind(workspaceId, preset.id),
          ]
        : []),
    ]
    const write = this.db
      .prepare(
        `INSERT INTO merge_threshold_presets
           (workspace_id, id, name, max_complexity, max_risk, max_impact, ci_max_attempts,
            max_requirement_iterations, max_requirement_concern_allowed,
            max_tester_quality_iterations,
            release_watch_window_minutes, release_max_attempts, human_review_grace_minutes,
            judge_min_score, judge_max_bounces,
            auto_merge_enabled, fork_decision, class_rules, class_rules_by_role, dry_run_roles,
            submission_classes_by_role, version, autonomy, is_default, is_unattended_default,
            created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (workspace_id, id) DO UPDATE SET
           name = excluded.name,
           max_complexity = excluded.max_complexity,
           max_risk = excluded.max_risk,
           max_impact = excluded.max_impact,
           ci_max_attempts = excluded.ci_max_attempts,
           max_requirement_iterations = excluded.max_requirement_iterations,
           max_requirement_concern_allowed = excluded.max_requirement_concern_allowed,
           max_tester_quality_iterations = excluded.max_tester_quality_iterations,
           release_watch_window_minutes = excluded.release_watch_window_minutes,
           release_max_attempts = excluded.release_max_attempts,
           human_review_grace_minutes = excluded.human_review_grace_minutes,
           judge_min_score = excluded.judge_min_score,
           judge_max_bounces = excluded.judge_max_bounces,
           auto_merge_enabled = excluded.auto_merge_enabled,
           fork_decision = excluded.fork_decision,
           class_rules = excluded.class_rules,
           class_rules_by_role = excluded.class_rules_by_role,
           dry_run_roles = excluded.dry_run_roles,
           submission_classes_by_role = excluded.submission_classes_by_role,
           version = excluded.version,
           autonomy = excluded.autonomy,
           is_default = excluded.is_default,
           is_unattended_default = excluded.is_unattended_default`,
      )
      .bind(
        workspaceId,
        preset.id,
        preset.name,
        preset.maxComplexity,
        preset.maxRisk,
        preset.maxImpact,
        preset.ciMaxAttempts,
        preset.maxRequirementIterations,
        preset.maxRequirementConcernAllowed,
        preset.maxTesterQualityIterations,
        preset.releaseWatchWindowMinutes,
        preset.releaseMaxAttempts,
        preset.humanReviewGraceMinutes,
        preset.judgeMinScore,
        preset.judgeMaxBounces,
        preset.autoMergeEnabled ? 1 : 0,
        preset.forkDecision ? JSON.stringify(preset.forkDecision) : null,
        JSON.stringify(preset.classRules ?? {}),
        JSON.stringify(preset.classRulesByRole ?? {}),
        JSON.stringify(preset.dryRunRoles ?? []),
        JSON.stringify(preset.submissionClassesByRole ?? {}),
        preset.version ?? null,
        preset.autonomy,
        preset.isDefault ? 1 : 0,
        preset.isUnattendedDefault ? 1 : 0,
        preset.createdAt,
      )
    await this.db.batch([...demotions, write])
  }

  async remove(workspaceId: string, id: string): Promise<void> {
    await this.db
      .prepare(
        `DELETE FROM merge_threshold_presets
           WHERE workspace_id = ? AND id = ? AND is_default = 0 AND is_unattended_default = 0`,
      )
      .bind(workspaceId, id)
      .run()
  }
}
