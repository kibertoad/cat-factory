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
/**
 * The severity threshold a task tolerates from the requirements reviewer before it stops
 * for a human. Mirrors the review item severities (`low`/`medium`/`high`) plus `none`,
 * which tolerates nothing. Ordered none < low < medium < high.
 */
export const requirementConcernLevelSchema = v.picklist(['none', 'low', 'medium', 'high'])
export type RequirementConcernLevel = v.InferOutput<typeof requirementConcernLevelSchema>

/** Rank of a {@link RequirementConcernLevel} for "at or below" comparisons. */
export const REQUIREMENT_CONCERN_RANK: Record<RequirementConcernLevel, number> = {
  none: 0,
  low: 1,
  medium: 2,
  high: 3,
}

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
  /**
   * How many reviewer passes the iterative requirements-review loop may run before it
   * stops on its own and asks the human to pick (extra round / proceed anyway / reset the
   * task). One reviewer pass = one iteration; the initial review counts as iteration 1.
   */
  maxRequirementIterations: v.pipe(v.number(), v.integer(), v.minValue(1)),
  /**
   * The highest finding severity the requirements review tolerates WITHOUT stopping. When
   * every outstanding finding from a reviewer pass is at or below this level, the findings
   * are recorded but the run does NOT pause for human approval — the incorporation
   * companion is skipped and the next pipeline step runs automatically. `none` (the
   * default) tolerates nothing, so any finding pauses for a human; `high` tolerates
   * everything. Severity order: none < low < medium < high.
   */
  maxRequirementConcernAllowed: requirementConcernLevelSchema,
  /**
   * How long (minutes) the post-release-health gate watches the deployed release's
   * Datadog monitors/SLOs before declaring it healthy and advancing.
   */
  releaseWatchWindowMinutes: v.pipe(v.number(), v.integer(), v.minValue(1)),
  /**
   * How many `on-call` investigations the post-release-health gate may dispatch while
   * watching before it gives up and raises a notification. The on-call agent investigates
   * rather than fixing prod, so 1 is the sensible default.
   */
  releaseMaxAttempts: v.pipe(v.number(), v.integer(), v.minValue(0)),
  /**
   * How long (minutes) the `human-review` gate waits after the latest review comment before
   * dispatching the `fixer` to address the batch — a grace window so a reviewer leaving a
   * series of comments isn't churned mid-stream. Only the unapproved path waits; an approved
   * PR's outstanding comments are addressed immediately.
   */
  humanReviewGraceMinutes: v.pipe(v.number(), v.integer(), v.minValue(0)),
  /**
   * When false the `merger` step never auto-merges: every PR is routed to a human
   * `merge_review` notification regardless of the assessment scores. The built-in
   * "Manual review only" preset sets this; a custom preset may too. Defaults to true
   * (the historical behaviour: auto-merge a within-threshold, explained assessment).
   */
  autoMergeEnabled: v.boolean(),
  /** The workspace's fallback preset, used by tasks that pick none. Exactly one is true. */
  isDefault: v.boolean(),
  /**
   * Monotonic seed version for a BUILT-IN preset (`seedMergePresets()` assigns it). When the
   * current catalog version for this id exceeds the persisted copy's `version`, the SPA offers
   * to reseed it. Absent on user-created presets (not version-tracked) and on rows persisted
   * before versioning existed (treated as 0).
   */
  version: v.optional(v.number()),
  createdAt: v.number(),
})
export type MergeThresholdPreset = v.InferOutput<typeof mergeThresholdPresetSchema>

// ---- Request bodies -------------------------------------------------------

const presetNameSchema = v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(60))
const scoreSchema = v.pipe(v.number(), v.minValue(0), v.maxValue(1))
const attemptsSchema = v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(50))
const iterationsSchema = v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(20))
const releaseWindowSchema = v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(720))
const releaseAttemptsSchema = v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(10))
const graceMinutesSchema = v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(1440))

/** Create a new merge threshold preset in a workspace. */
export const createMergePresetSchema = v.object({
  name: presetNameSchema,
  maxComplexity: scoreSchema,
  maxRisk: scoreSchema,
  maxImpact: scoreSchema,
  ciMaxAttempts: attemptsSchema,
  maxRequirementIterations: iterationsSchema,
  maxRequirementConcernAllowed: requirementConcernLevelSchema,
  releaseWatchWindowMinutes: v.optional(releaseWindowSchema, 30),
  releaseMaxAttempts: v.optional(releaseAttemptsSchema, 1),
  humanReviewGraceMinutes: v.optional(graceMinutesSchema, 10),
  /** Allow auto-merge of a within-threshold, explained assessment (default true). */
  autoMergeEnabled: v.optional(v.boolean(), true),
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
  maxRequirementIterations: v.optional(iterationsSchema),
  maxRequirementConcernAllowed: v.optional(requirementConcernLevelSchema),
  releaseWatchWindowMinutes: v.optional(releaseWindowSchema),
  releaseMaxAttempts: v.optional(releaseAttemptsSchema),
  humanReviewGraceMinutes: v.optional(graceMinutesSchema),
  autoMergeEnabled: v.optional(v.boolean()),
  isDefault: v.optional(v.boolean()),
})
export type UpdateMergePresetInput = v.InferOutput<typeof updateMergePresetSchema>

/** Parse-or-throw an assessment payload an agent returned (the engine validates it). */
export function parseMergeAssessment(value: unknown): MergeAssessment {
  return v.parse(mergeAssessmentSchema, value)
}

// ---------------------------------------------------------------------------
// Merge DECISION — the engine's resolved verdict for a completed `merger` step,
// persisted on the step (`step.custom`) so the SPA can render the assessment nicely
// AND explain WHY the engine auto-merged or routed the PR to a human. The `merger`
// agent only produces the assessment (scores + rationale); the engine (MergeResolver)
// compares it against the task's resolved preset and records this alongside.
// ---------------------------------------------------------------------------

/** Which assessment axis exceeded its preset ceiling. */
export const mergeAxisSchema = v.picklist(['complexity', 'risk', 'impact'])
export type MergeAxis = v.InferOutput<typeof mergeAxisSchema>

/** The preset ceilings the assessment was compared against (for the decision banner). */
export const mergeDecisionThresholdsSchema = v.object({
  /** The resolved preset's display name (e.g. "Balanced"). */
  presetName: v.string(),
  maxComplexity: v.pipe(v.number(), v.minValue(0), v.maxValue(1)),
  maxRisk: v.pipe(v.number(), v.minValue(0), v.maxValue(1)),
  maxImpact: v.pipe(v.number(), v.minValue(0), v.maxValue(1)),
  autoMergeEnabled: v.boolean(),
})
export type MergeDecisionThresholds = v.InferOutput<typeof mergeDecisionThresholdsSchema>

export const mergeDecisionSchema = v.object({
  /** What the engine did: merged the PR for real, or left it open for a human. */
  outcome: v.picklist(['auto_merged', 'awaiting_review']),
  /**
   * Why — drives the human-readable banner:
   *  - `within_thresholds`: auto-merged; every axis at/below the preset ceiling.
   *  - `exceeded_thresholds`: review; one or more axes over the ceiling (`exceededAxes`).
   *  - `auto_merge_disabled`: review; the preset routes every PR to a human.
   *  - `no_assessment`: review; the merger produced no valid assessment.
   *  - `merge_failed`: review; within threshold but the real merge threw (e.g. branch
   *    protection / conflict), so it fell through to human review.
   */
  reason: v.picklist([
    'within_thresholds',
    'exceeded_thresholds',
    'auto_merge_disabled',
    'no_assessment',
    'merge_failed',
  ]),
  /** The merger's assessment (absent only when it produced no parseable one). */
  assessment: v.optional(mergeAssessmentSchema),
  thresholds: mergeDecisionThresholdsSchema,
  /** The axes that exceeded their ceiling (empty unless `reason` is `exceeded_thresholds`). */
  exceededAxes: v.array(mergeAxisSchema),
})
export type MergeDecision = v.InferOutput<typeof mergeDecisionSchema>
