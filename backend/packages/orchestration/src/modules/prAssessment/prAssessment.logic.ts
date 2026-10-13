import {
  dryRunForcedForRole,
  isPrAssessmentVerdictReason,
  parseMergeAssessment,
  resolveRoleScopedMergeClassRule,
  submissionAllowedForRole,
  type PublicPrAssessmentVerdict,
  type WorkspaceRole,
} from '@cat-factory/contracts'
import type { ChangeClass, MergeAssessment, RiskPolicy } from '@cat-factory/kernel'
import { UnavailableError, ValidationError } from '@cat-factory/kernel'
import {
  exceededAxesOf,
  isCredibleAssessment,
  resolveMergePrecedence,
} from '../merge/mergePrecedence.js'

/** Prompt budget for the patches inlined into the one assessment call. */
export const PR_ASSESSMENT_INLINE_PATCH_CHARS = 60_000

/** The deadline on the model call, so a stalled vendor cannot hold the request open. */
export const PR_ASSESSMENT_TIMEOUT_MS = 120_000

/**
 * What the verdict reads off a policy: its ceilings, its master switch, its class rules and the
 * role layer that narrows them for the person a key acts for.
 */
export type PrAssessmentPolicy = Pick<
  RiskPolicy,
  | 'id'
  | 'name'
  | 'maxComplexity'
  | 'maxRisk'
  | 'maxImpact'
  | 'autoMergeEnabled'
  | 'classRules'
  | 'classRulesByRole'
  | 'dryRunRoles'
  | 'submissionClassesByRole'
>

/**
 * The policy an assessment is judged against: the named one, else the workspace's UNATTENDED
 * default, which is the one a run started through the API resolves.
 *
 * An unknown id is refused rather than replaced by the default, as on task create: a verdict
 * against a policy the caller did not name would read as an answer to the question they asked.
 */
export function selectAssessmentPolicy<
  P extends PrAssessmentPolicy & { isUnattendedDefault: boolean },
>(library: readonly P[], riskPolicyId: string | undefined): P {
  if (riskPolicyId !== undefined) {
    const named = library.find((policy) => policy.id === riskPolicyId)
    if (!named) {
      throw new ValidationError(`No risk policy '${riskPolicyId}' in this workspace.`, {
        reason: 'risk_policy_not_found',
      })
    }
    return named
  }
  const fallback = library.find((policy) => policy.isUnattendedDefault)
  if (!fallback) {
    throw new UnavailableError(
      'This workspace has no unattended default risk policy',
      'risk_policy_default_missing',
    )
  }
  return fallback
}

/** The model's reply as an assessment, or null when it is not one. */
export function coercePrAssessment(raw: unknown): MergeAssessment | null {
  try {
    return parseMergeAssessment(raw)
  } catch {
    return null
  }
}

/**
 * Whether `policy` would land a PR with this assessment and change class, by the same ladder the
 * merger step's resolver applies, for a run started by `role`.
 *
 * `role` is what a run started by the same key would pin: the bound person's workspace role, or
 * null for a key bound to nobody (and for a bound person whose access no longer resolves), which
 * no role entry matches. The role is read through the same contracts helpers run admission and
 * the resolver use, so a policy that sandboxes, scopes or narrows that role here does so there.
 * Only the request-scoped rung is fixed: an assessment is never a requested dry run. A resolved
 * policy always has an id, and the reply was parsed before this is reached.
 */
export function evaluatePrAssessmentVerdict(
  policy: PrAssessmentPolicy,
  assessment: MergeAssessment,
  changeClass: ChangeClass,
  role: WorkspaceRole | null,
): PublicPrAssessmentVerdict {
  const { effective: effectiveRule, narrowedByRole } = resolveRoleScopedMergeClassRule({
    rules: policy.classRules,
    byRole: policy.classRulesByRole,
    role,
    changeClass,
  })
  const exceededAxes = exceededAxesOf(assessment, policy)
  const { merge, mergeReason, reviewReason } = resolveMergePrecedence({
    dryRun: dryRunForcedForRole(policy.dryRunRoles, role),
    submissionAllowed: submissionAllowedForRole(policy.submissionClassesByRole, role, changeClass),
    autoMergeEnabled: policy.autoMergeEnabled,
    policyConfigured: true,
    effectiveRule,
    narrowedByRole,
    hasAssessment: true,
    credible: isCredibleAssessment(assessment),
    withinThresholds: exceededAxes.length === 0,
  })
  const reason = merge ? mergeReason : reviewReason
  if (!isPrAssessmentVerdictReason(reason)) {
    throw new Error(`A PR assessment reached the merge reason '${reason}', which it cannot carry`)
  }
  return merge
    ? { outcome: 'within_policy', reason, exceededAxes: [] }
    : { outcome: 'requires_review', reason, exceededAxes }
}
