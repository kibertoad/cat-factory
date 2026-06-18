import * as v from 'valibot'

// ---------------------------------------------------------------------------
// Merge-policy wire contracts. After a pipeline's implementation work is done
// and CI is green, a `merger` agent assesses the pull request along three axes —
// complexity, risk and impact (each scored 0..1) — and the engine compares those
// scores against the task's resolved *merge threshold preset*. If every score is
// at or below its configured ceiling the PR is merged automatically; otherwise a
// `merge_review` notification is raised for a human to act on.
//
// Presets are authored per workspace (a small library of named policies, e.g.
// "Cautious", "Trusted") and one is selected per task; a task with no explicit
// selection resolves to the workspace's default preset. The preset also carries
// the CI-fixer attempt budget (how many times the `ci-fixer` agent may try to get
// CI green before the run gives up).
// ---------------------------------------------------------------------------

/**
 * A `merger` agent's structured assessment of a pull request. Each axis is scored
 * 0..1 (higher = more complex / riskier / higher blast-radius); `rationale` is the
 * agent's prose justification, surfaced to a human when the PR needs review.
 */
export const mergeAssessmentSchema = v.object({
  /** How intricate the change is (size, coupling, subtlety). */
  complexity: v.pipe(v.number(), v.minValue(0), v.maxValue(1)),
  /** Likelihood the change breaks something (test coverage, fragility). */
  risk: v.pipe(v.number(), v.minValue(0), v.maxValue(1)),
  /** Blast radius if it does break (how much/who it affects). */
  impact: v.pipe(v.number(), v.minValue(0), v.maxValue(1)),
  /** The agent's plain-prose justification for the scores + a merge recommendation. */
  rationale: v.string(),
})
export type MergeAssessment = v.InferOutput<typeof mergeAssessmentSchema>

/**
 * A named, per-workspace merge policy: the upper bounds (0..1) a PR's assessment
 * must stay within to auto-merge, plus the CI-fixer attempt budget. Exactly one
 * preset per workspace is the default (`isDefault`), used by any task that has not
 * picked one explicitly.
 */
export const mergeThresholdPresetSchema = v.object({
  id: v.string(),
  name: v.string(),
  /** Auto-merge only when the assessment's complexity is at or below this. */
  maxComplexity: v.pipe(v.number(), v.minValue(0), v.maxValue(1)),
  /** Auto-merge only when the assessment's risk is at or below this. */
  maxRisk: v.pipe(v.number(), v.minValue(0), v.maxValue(1)),
  /** Auto-merge only when the assessment's impact is at or below this. */
  maxImpact: v.pipe(v.number(), v.minValue(0), v.maxValue(1)),
  /** How many times the `ci-fixer` agent may try to turn CI green before giving up. */
  ciMaxAttempts: v.pipe(v.number(), v.integer(), v.minValue(0)),
  /** The workspace's fallback preset, used by tasks that pick none. Exactly one is true. */
  isDefault: v.boolean(),
  createdAt: v.number(),
})
export type MergeThresholdPreset = v.InferOutput<typeof mergeThresholdPresetSchema>

// ---- Request bodies -------------------------------------------------------

const presetNameSchema = v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(60))
const scoreSchema = v.pipe(v.number(), v.minValue(0), v.maxValue(1))
const attemptsSchema = v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(50))

/** Create a new merge threshold preset in a workspace. */
export const createMergePresetSchema = v.object({
  name: presetNameSchema,
  maxComplexity: scoreSchema,
  maxRisk: scoreSchema,
  maxImpact: scoreSchema,
  ciMaxAttempts: attemptsSchema,
  /** Make this the workspace default (demotes the previous default). */
  isDefault: v.optional(v.boolean(), false),
})
export type CreateMergePresetInput = v.InferOutput<typeof createMergePresetSchema>

/** Patch an existing merge threshold preset (all fields optional). */
export const updateMergePresetSchema = v.object({
  name: v.optional(presetNameSchema),
  maxComplexity: v.optional(scoreSchema),
  maxRisk: v.optional(scoreSchema),
  maxImpact: v.optional(scoreSchema),
  ciMaxAttempts: v.optional(attemptsSchema),
  isDefault: v.optional(v.boolean()),
})
export type UpdateMergePresetInput = v.InferOutput<typeof updateMergePresetSchema>

/** Parse-or-throw an assessment payload an agent returned (the engine validates it). */
export function parseMergeAssessment(value: unknown): MergeAssessment {
  return v.parse(mergeAssessmentSchema, value)
}
