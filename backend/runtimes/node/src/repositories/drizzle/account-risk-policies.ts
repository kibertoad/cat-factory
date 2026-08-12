import type {
  AccountRiskPolicy,
  AccountRiskPolicyRepository,
  RiskPolicySuppressionRepository,
} from '@cat-factory/kernel'
import { and, eq, inArray } from 'drizzle-orm'
import { accountRiskPolicies, riskPolicySuppressions } from '../../db/schema.js'
import type { DrizzleDb } from '../../db/client.js'

/**
 * Chunk size for the batched `IN` read, matching the D1 mirror. Postgres would take far more bound
 * parameters, but the two facades chunk identically so a conformance assertion over a large id set
 * exercises the same code path on both.
 */
const ID_CHUNK = 90

type AccountRiskPolicyRow = typeof accountRiskPolicies.$inferSelect

/**
 * A stored account row → the domain policy. Byte-for-byte the reading `D1AccountRiskPolicyRepository`
 * applies, including the defensive JSON reads (each empty value is that field's identity) and the
 * NARROWED `autonomy`: a stored value the closed vocabulary no longer carries reads as `attended`,
 * the posture that stops for a person, never as a licence this row cannot be shown to have granted.
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
    maxRequirementConcernAllowed:
      row.max_requirement_concern_allowed as AccountRiskPolicy['maxRequirementConcernAllowed'],
    maxTesterQualityIterations: row.max_tester_quality_iterations,
    releaseWatchWindowMinutes: row.release_watch_window_minutes,
    releaseMaxAttempts: row.release_max_attempts,
    humanReviewGraceMinutes: row.human_review_grace_minutes,
    judgeMinScore: row.judge_min_score,
    judgeMaxBounces: row.judge_max_bounces,
    autoMergeEnabled: row.auto_merge_enabled === 1,
    forkDecision: row.fork_decision
      ? (JSON.parse(row.fork_decision) as AccountRiskPolicy['forkDecision'])
      : null,
    classRules: row.class_rules
      ? (JSON.parse(row.class_rules) as AccountRiskPolicy['classRules'])
      : {},
    classRulesByRole: row.class_rules_by_role
      ? (JSON.parse(row.class_rules_by_role) as AccountRiskPolicy['classRulesByRole'])
      : {},
    dryRunRoles: row.dry_run_roles
      ? (JSON.parse(row.dry_run_roles) as AccountRiskPolicy['dryRunRoles'])
      : [],
    submissionClassesByRole: row.submission_classes_by_role
      ? (JSON.parse(row.submission_classes_by_role) as AccountRiskPolicy['submissionClassesByRole'])
      : {},
    autonomy: row.autonomy === 'unattended' ? 'unattended' : 'attended',
    minAutoAnswerConfidence: row.min_auto_answer_confidence,
    ...(row.version != null ? { version: row.version } : {}),
    createdAt: row.created_at,
  }
}

/**
 * ACCOUNT-tier risk policies over Postgres (the Drizzle mirror of the Worker's
 * `D1AccountRiskPolicyRepository`, migration 0092). Behaviourally identical, so the cross-runtime
 * conformance suite asserts the same tier merge on both facades.
 *
 * No default-promotion machinery, unlike the workspace-tier repository: an account row holds no
 * per-scope default claim, so there is no cross-row invariant and every write is a plain upsert. See
 * ADR 0055.
 */
export class DrizzleAccountRiskPolicyRepository implements AccountRiskPolicyRepository {
  constructor(private readonly db: DrizzleDb) {}

  async get(accountId: string, id: string): Promise<AccountRiskPolicy | null> {
    const rows = await this.db
      .select()
      .from(accountRiskPolicies)
      .where(and(eq(accountRiskPolicies.account_id, accountId), eq(accountRiskPolicies.id, id)))
      .limit(1)
    return rows[0] ? rowToPolicy(rows[0]) : null
  }

  async list(accountId: string): Promise<AccountRiskPolicy[]> {
    const rows = await this.db
      .select()
      .from(accountRiskPolicies)
      .where(eq(accountRiskPolicies.account_id, accountId))
      .orderBy(accountRiskPolicies.created_at)
    return rows.map(rowToPolicy)
  }

  async listByIds(accountId: string, ids: string[]): Promise<AccountRiskPolicy[]> {
    const wanted = [...new Set(ids)].filter(Boolean)
    // An empty set is a no-op rather than a dropped predicate, which would answer the whole tier to
    // a caller that asked about nothing.
    if (wanted.length === 0) return []
    const rows: AccountRiskPolicyRow[] = []
    for (let i = 0; i < wanted.length; i += ID_CHUNK) {
      const chunk = wanted.slice(i, i + ID_CHUNK)
      rows.push(
        ...(await this.db
          .select()
          .from(accountRiskPolicies)
          .where(
            and(
              eq(accountRiskPolicies.account_id, accountId),
              inArray(accountRiskPolicies.id, chunk),
            ),
          )
          .orderBy(accountRiskPolicies.created_at)),
      )
    }
    return rows.map(rowToPolicy)
  }

  async upsert(accountId: string, policy: AccountRiskPolicy): Promise<void> {
    const values = {
      account_id: accountId,
      id: policy.id,
      name: policy.name,
      max_complexity: policy.maxComplexity,
      max_risk: policy.maxRisk,
      max_impact: policy.maxImpact,
      ci_max_attempts: policy.ciMaxAttempts,
      max_requirement_iterations: policy.maxRequirementIterations,
      max_requirement_concern_allowed: policy.maxRequirementConcernAllowed,
      max_tester_quality_iterations: policy.maxTesterQualityIterations,
      release_watch_window_minutes: policy.releaseWatchWindowMinutes,
      release_max_attempts: policy.releaseMaxAttempts,
      human_review_grace_minutes: policy.humanReviewGraceMinutes,
      judge_min_score: policy.judgeMinScore,
      judge_max_bounces: policy.judgeMaxBounces,
      auto_merge_enabled: policy.autoMergeEnabled ? 1 : 0,
      fork_decision: policy.forkDecision ? JSON.stringify(policy.forkDecision) : null,
      class_rules: JSON.stringify(policy.classRules ?? {}),
      class_rules_by_role: JSON.stringify(policy.classRulesByRole ?? {}),
      dry_run_roles: JSON.stringify(policy.dryRunRoles ?? []),
      submission_classes_by_role: JSON.stringify(policy.submissionClassesByRole ?? {}),
      version: policy.version ?? null,
      autonomy: policy.autonomy,
      min_auto_answer_confidence: policy.minAutoAnswerConfidence,
      created_at: policy.createdAt,
    }
    await this.db
      .insert(accountRiskPolicies)
      .values(values)
      .onConflictDoUpdate({
        target: [accountRiskPolicies.account_id, accountRiskPolicies.id],
        // Every editable column is projected. The one this mirrors had a silent gap for exactly this
        // reason (the judge pair was on the INSERT and missing from the update), which an in-memory
        // unit test cannot see: an edit simply left the stored value untouched.
        set: {
          name: values.name,
          max_complexity: values.max_complexity,
          max_risk: values.max_risk,
          max_impact: values.max_impact,
          ci_max_attempts: values.ci_max_attempts,
          max_requirement_iterations: values.max_requirement_iterations,
          max_requirement_concern_allowed: values.max_requirement_concern_allowed,
          max_tester_quality_iterations: values.max_tester_quality_iterations,
          release_watch_window_minutes: values.release_watch_window_minutes,
          release_max_attempts: values.release_max_attempts,
          human_review_grace_minutes: values.human_review_grace_minutes,
          judge_min_score: values.judge_min_score,
          judge_max_bounces: values.judge_max_bounces,
          auto_merge_enabled: values.auto_merge_enabled,
          fork_decision: values.fork_decision,
          class_rules: values.class_rules,
          class_rules_by_role: values.class_rules_by_role,
          dry_run_roles: values.dry_run_roles,
          submission_classes_by_role: values.submission_classes_by_role,
          version: values.version,
          autonomy: values.autonomy,
          min_auto_answer_confidence: values.min_auto_answer_confidence,
        },
      })
  }

  async remove(accountId: string, id: string): Promise<void> {
    await this.db
      .delete(accountRiskPolicies)
      .where(and(eq(accountRiskPolicies.account_id, accountId), eq(accountRiskPolicies.id, id)))
  }
}

/** Which inherited policies a board HIDES (the Drizzle mirror of migration 0092's suppressions). */
export class DrizzleRiskPolicySuppressionRepository implements RiskPolicySuppressionRepository {
  constructor(private readonly db: DrizzleDb) {}

  async list(workspaceId: string): Promise<string[]> {
    const rows = await this.db
      .select({ policyId: riskPolicySuppressions.policy_id })
      .from(riskPolicySuppressions)
      .where(eq(riskPolicySuppressions.workspace_id, workspaceId))
      .orderBy(riskPolicySuppressions.created_at)
    return rows.map((row) => row.policyId)
  }

  async add(workspaceId: string, policyId: string, at: number): Promise<void> {
    // FIRST write wins, mirroring the D1 `DO NOTHING`: hiding an already-hidden policy is the same
    // state, so a retry keeps the original timestamp and the editor's ordering is stable across a
    // double-click. Targeted on the primary key alone, never a bare ignore.
    await this.db
      .insert(riskPolicySuppressions)
      .values({ workspace_id: workspaceId, policy_id: policyId, created_at: at })
      .onConflictDoNothing({
        target: [riskPolicySuppressions.workspace_id, riskPolicySuppressions.policy_id],
      })
  }

  async remove(workspaceId: string, policyId: string): Promise<void> {
    await this.db
      .delete(riskPolicySuppressions)
      .where(
        and(
          eq(riskPolicySuppressions.workspace_id, workspaceId),
          eq(riskPolicySuppressions.policy_id, policyId),
        ),
      )
  }
}
