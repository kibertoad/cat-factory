import * as v from 'valibot'
import { mergeAssessmentSchema, mergeAxisSchema, type MergeDecision } from './merge.js'
import { changeClassSchema } from './mergeTrackRecord.js'
import { vcsProviderSchema } from './routes/auth.js'

// Public PR assessment: cat-factory scores an arbitrary pull request in a linked repository on the
// merger's three axes and says whether a named risk policy would let it land without a person.
// The policy's ceilings stay internal (see `publicRiskPolicySchema`); the verdict is what leaves.

export const assessPublicPullRequestSchema = v.object({
  owner: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(200)),
  repo: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(200)),
  prNumber: v.pipe(v.number(), v.integer(), v.minValue(1)),
  provider: v.optional(vcsProviderSchema),
  /** A policy id from `GET /api/v1/risk-policies`; omitted ⇒ the workspace's unattended default. */
  riskPolicyId: v.optional(v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(120))),
})
export type AssessPublicPullRequestInput = v.InferOutput<typeof assessPublicPullRequestSchema>

/**
 * The merge-decision reasons a verdict can carry. Only the ones that apply with no run behind
 * them: an API key carries no role and a PR assessed here is never a dry run, so the role-scoped
 * and run-scoped reasons cannot arise.
 */
export const PR_ASSESSMENT_VERDICT_REASONS = [
  'within_thresholds',
  'exceeded_thresholds',
  'auto_merge_disabled',
  'no_rationale',
  'class_auto_merge',
  'class_requires_review',
] as const satisfies readonly MergeDecision['reason'][]
export type PrAssessmentVerdictReason = (typeof PR_ASSESSMENT_VERDICT_REASONS)[number]

/** Whether a merge-decision reason is one a PR assessment verdict may carry. */
export function isPrAssessmentVerdictReason(
  reason: MergeDecision['reason'],
): reason is PrAssessmentVerdictReason {
  return (PR_ASSESSMENT_VERDICT_REASONS as readonly string[]).includes(reason)
}

export const publicPrAssessmentVerdictSchema = v.object({
  /** `within_policy`: the policy would land this PR with no person. */
  outcome: v.picklist(['within_policy', 'requires_review']),
  reason: v.picklist(PR_ASSESSMENT_VERDICT_REASONS),
  /** The axes scored above the policy's ceiling; empty when the verdict is `within_policy`. */
  exceededAxes: v.array(mergeAxisSchema),
})
export type PublicPrAssessmentVerdict = v.InferOutput<typeof publicPrAssessmentVerdictSchema>

export const publicPrAssessmentPolicySchema = v.object({
  policyId: v.string(),
  name: v.string(),
})
export type PublicPrAssessmentPolicy = v.InferOutput<typeof publicPrAssessmentPolicySchema>

export const publicPrAssessmentSchema = v.object({
  provider: vcsProviderSchema,
  owner: v.string(),
  repo: v.string(),
  prNumber: v.number(),
  /** The commit the assessment describes. */
  headSha: v.string(),
  /** Derived from the changed paths, never from the model. */
  changeClass: changeClassSchema,
  changedFileCount: v.number(),
  /** The merger's three axes and its rationale. */
  assessment: mergeAssessmentSchema,
  /** `provider:model` the assessment ran on. */
  model: v.nullable(v.string()),
  policy: publicPrAssessmentPolicySchema,
  verdict: publicPrAssessmentVerdictSchema,
  assessedAt: v.number(),
})
export type PublicPrAssessment = v.InferOutput<typeof publicPrAssessmentSchema>
