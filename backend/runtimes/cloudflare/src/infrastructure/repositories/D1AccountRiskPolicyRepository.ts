import type {
  AccountRiskPolicy,
  AccountRiskPolicyRepository,
  RiskPolicySuppressionRepository,
} from '@cat-factory/kernel'
import type {
  ClassRulesByRole,
  MergeClassRules,
  RequirementConcernLevel,
  StepGating,
  SubmissionClassesByRole,
  WorkspaceRole,
} from '@cat-factory/contracts'
import type { D1Database } from '@cloudflare/workers-types'

/**
 * Chunk size for the batched `IN` read. D1 caps bound parameters per statement, and a board's
 * suppression list is short, so one chunk covers every realistic case and the loop is the guard
 * against an account that grew unusually large rather than the expected path.
 */
const ID_CHUNK = 90

interface AccountRiskPolicyRow {
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
  min_auto_answer_confidence: number
  created_at: number
}

/**
 * A stored account row → the domain policy.
 *
 * Every defensive read here matches `D1RiskPolicyRepository`'s twin for the same reasons, and the one
 * worth restating is `autonomy`: the value is NARROWED rather than cast, so a row written under a
 * member later retired reads back as `attended` — the posture that stops for a person, never a
 * licence this row cannot be shown to have granted.
 */
function rowToPolicy(row: AccountRiskPolicyRow): AccountRiskPolicy {
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
    classRules: row.class_rules ? (JSON.parse(row.class_rules) as MergeClassRules) : {},
    classRulesByRole: row.class_rules_by_role
      ? (JSON.parse(row.class_rules_by_role) as ClassRulesByRole)
      : {},
    dryRunRoles: row.dry_run_roles ? (JSON.parse(row.dry_run_roles) as WorkspaceRole[]) : [],
    submissionClassesByRole: row.submission_classes_by_role
      ? (JSON.parse(row.submission_classes_by_role) as SubmissionClassesByRole)
      : {},
    autonomy: row.autonomy === 'unattended' ? 'unattended' : 'attended',
    minAutoAnswerConfidence: row.min_auto_answer_confidence,
    ...(row.version != null ? { version: row.version } : {}),
    createdAt: row.created_at,
  }
}

/**
 * ACCOUNT-tier risk policies, one row per policy in `account_risk_policies` (migration 0092).
 *
 * No default-promotion machinery, unlike its workspace-tier twin: an account row holds no per-scope
 * default claim, so there is no invariant to enforce across the tier and every write is a plain
 * upsert. See ADR 0055.
 */
export class D1AccountRiskPolicyRepository implements AccountRiskPolicyRepository {
  private readonly db: D1Database

  constructor({ db }: { db: D1Database }) {
    this.db = db
  }

  async get(accountId: string, id: string): Promise<AccountRiskPolicy | null> {
    const row = await this.db
      .prepare(`SELECT * FROM account_risk_policies WHERE account_id = ? AND id = ?`)
      .bind(accountId, id)
      .first<AccountRiskPolicyRow>()
    return row ? rowToPolicy(row) : null
  }

  async list(accountId: string): Promise<AccountRiskPolicy[]> {
    const { results } = await this.db
      .prepare(`SELECT * FROM account_risk_policies WHERE account_id = ? ORDER BY created_at ASC`)
      .bind(accountId)
      .all<AccountRiskPolicyRow>()
    return results.map(rowToPolicy)
  }

  async listByIds(accountId: string, ids: string[]): Promise<AccountRiskPolicy[]> {
    const wanted = [...new Set(ids)].filter(Boolean)
    // An empty set is a no-op, never a full-table read: `IN ()` is a syntax error and dropping the
    // predicate would answer the whole tier for a caller that asked about nothing.
    if (wanted.length === 0) return []
    const rows: AccountRiskPolicyRow[] = []
    for (let i = 0; i < wanted.length; i += ID_CHUNK) {
      const chunk = wanted.slice(i, i + ID_CHUNK)
      const holes = chunk.map(() => '?').join(', ')
      const { results } = await this.db
        .prepare(
          `SELECT * FROM account_risk_policies
             WHERE account_id = ? AND id IN (${holes})
             ORDER BY created_at ASC`,
        )
        .bind(accountId, ...chunk)
        .all<AccountRiskPolicyRow>()
      rows.push(...results)
    }
    return rows.map(rowToPolicy)
  }

  async upsert(accountId: string, policy: AccountRiskPolicy): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO account_risk_policies
           (account_id, id, name, max_complexity, max_risk, max_impact, ci_max_attempts,
            max_requirement_iterations, max_requirement_concern_allowed,
            max_tester_quality_iterations,
            release_watch_window_minutes, release_max_attempts, human_review_grace_minutes,
            judge_min_score, judge_max_bounces,
            auto_merge_enabled, fork_decision, class_rules, class_rules_by_role, dry_run_roles,
            submission_classes_by_role, version, autonomy, min_auto_answer_confidence,
            created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (account_id, id) DO UPDATE SET
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
           min_auto_answer_confidence = excluded.min_auto_answer_confidence`,
      )
      .bind(
        accountId,
        policy.id,
        policy.name,
        policy.maxComplexity,
        policy.maxRisk,
        policy.maxImpact,
        policy.ciMaxAttempts,
        policy.maxRequirementIterations,
        policy.maxRequirementConcernAllowed,
        policy.maxTesterQualityIterations,
        policy.releaseWatchWindowMinutes,
        policy.releaseMaxAttempts,
        policy.humanReviewGraceMinutes,
        policy.judgeMinScore,
        policy.judgeMaxBounces,
        policy.autoMergeEnabled ? 1 : 0,
        policy.forkDecision ? JSON.stringify(policy.forkDecision) : null,
        JSON.stringify(policy.classRules ?? {}),
        JSON.stringify(policy.classRulesByRole ?? {}),
        JSON.stringify(policy.dryRunRoles ?? []),
        JSON.stringify(policy.submissionClassesByRole ?? {}),
        policy.version ?? null,
        policy.autonomy,
        policy.minAutoAnswerConfidence,
        policy.createdAt,
      )
      .run()
  }

  async remove(accountId: string, id: string): Promise<void> {
    await this.db
      .prepare(`DELETE FROM account_risk_policies WHERE account_id = ? AND id = ?`)
      .bind(accountId, id)
      .run()
  }
}

/**
 * Which inherited policies a board HIDES, one row per suppressed id in `risk_policy_suppressions`
 * (migration 0092).
 */
export class D1RiskPolicySuppressionRepository implements RiskPolicySuppressionRepository {
  private readonly db: D1Database

  constructor({ db }: { db: D1Database }) {
    this.db = db
  }

  async list(workspaceId: string): Promise<string[]> {
    const { results } = await this.db
      .prepare(
        `SELECT policy_id FROM risk_policy_suppressions
           WHERE workspace_id = ? ORDER BY created_at ASC`,
      )
      .bind(workspaceId)
      .all<{ policy_id: string }>()
    return results.map((row) => row.policy_id)
  }

  async add(workspaceId: string, policyId: string, at: number): Promise<void> {
    // FIRST write wins: hiding an already-hidden policy is the same state, so the retry keeps the
    // original timestamp rather than re-stamping it. `DO NOTHING` targets the primary key alone, so
    // the suppression's own order in the editor's list is stable across a double-click.
    await this.db
      .prepare(
        `INSERT INTO risk_policy_suppressions (workspace_id, policy_id, created_at)
         VALUES (?, ?, ?)
         ON CONFLICT (workspace_id, policy_id) DO NOTHING`,
      )
      .bind(workspaceId, policyId, at)
      .run()
  }

  async remove(workspaceId: string, policyId: string): Promise<void> {
    await this.db
      .prepare(`DELETE FROM risk_policy_suppressions WHERE workspace_id = ? AND policy_id = ?`)
      .bind(workspaceId, policyId)
      .run()
  }
}
