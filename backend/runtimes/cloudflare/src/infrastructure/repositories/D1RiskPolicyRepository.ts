import type { RiskPolicyRepository } from '@cat-factory/kernel'
import type {
  ClassRulesByRole,
  MergeClassRules,
  RiskPolicy,
  RequirementConcernLevel,
  StepGating,
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
  version: number | null
  is_default: number
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
    isDefault: row.is_default === 1,
    ...(row.version != null ? { version: row.version } : {}),
    createdAt: row.created_at,
  }
}

/**
 * Merge threshold presets, one row per preset in `merge_threshold_presets`
 * (migration 0024). Enforces the single-default invariant: promoting a preset to
 * default demotes every other in the workspace, in one statement before the
 * upsert. The default preset cannot be removed (the service keeps that rule).
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

  async getDefault(workspaceId: string): Promise<RiskPolicy | null> {
    const row = await this.db
      .prepare(
        `SELECT * FROM merge_threshold_presets
           WHERE workspace_id = ? AND is_default = 1
           ORDER BY created_at ASC LIMIT 1`,
      )
      .bind(workspaceId)
      .first<RiskPolicyRow>()
    return row ? rowToPreset(row) : null
  }

  async upsert(workspaceId: string, preset: RiskPolicy): Promise<void> {
    // Promoting this preset to default demotes any other default first, so the
    // single-default invariant holds.
    if (preset.isDefault) {
      await this.db
        .prepare(
          `UPDATE merge_threshold_presets SET is_default = 0
             WHERE workspace_id = ? AND id <> ?`,
        )
        .bind(workspaceId, preset.id)
        .run()
    }
    await this.db
      .prepare(
        `INSERT INTO merge_threshold_presets
           (workspace_id, id, name, max_complexity, max_risk, max_impact, ci_max_attempts,
            max_requirement_iterations, max_requirement_concern_allowed,
            max_tester_quality_iterations,
            release_watch_window_minutes, release_max_attempts, human_review_grace_minutes,
            judge_min_score, judge_max_bounces,
            auto_merge_enabled, fork_decision, class_rules, class_rules_by_role, dry_run_roles,
            version, is_default, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
           version = excluded.version,
           is_default = excluded.is_default`,
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
        preset.version ?? null,
        preset.isDefault ? 1 : 0,
        preset.createdAt,
      )
      .run()
  }

  async remove(workspaceId: string, id: string): Promise<void> {
    await this.db
      .prepare(
        `DELETE FROM merge_threshold_presets WHERE workspace_id = ? AND id = ? AND is_default = 0`,
      )
      .bind(workspaceId, id)
      .run()
  }
}
