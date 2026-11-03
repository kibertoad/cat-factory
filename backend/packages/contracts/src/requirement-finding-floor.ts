import * as v from 'valibot'

// ---------------------------------------------------------------------------
// How verbose a requirements review is: the lowest severity it RAISES. Distinct from
// `RiskPolicy.maxRequirementConcernAllowed`, which decides whether findings that WERE raised stop
// the run. A finding below the floor never reaches anyone; one above it is raised and may still
// auto-pass under that tolerance.
//
// Stated here rather than in the engine because the risk-policy editor shows what a progression
// resolves to and the review window shows what a pass resolved, and both must read the rule the
// engine applied.
// ---------------------------------------------------------------------------

/** How important resolving a review item is before implementation should proceed. */
export const reviewItemSeveritySchema = v.picklist(['low', 'medium', 'high'])
export type ReviewItemSeverity = v.InferOutput<typeof reviewItemSeveritySchema>

/** Rank of a severity for "at or above the floor" comparisons. */
export const REVIEW_ITEM_SEVERITY_RANK: Record<ReviewItemSeverity, number> = {
  low: 1,
  medium: 2,
  high: 3,
}

/** The floor a policy states when it says nothing else: raise `medium` and `high`, drop `low`. */
export const DEFAULT_REQUIREMENT_FINDING_FLOOR: ReviewItemSeverity = 'medium'

/**
 * Read a stored floor back. Both facades keep it as text; a value this build cannot name reads as
 * the shipped default on both, the same answer a row that predates the column gets.
 */
export function parseRequirementFindingFloor(raw: string | null | undefined): ReviewItemSeverity {
  const parsed = v.safeParse(reviewItemSeveritySchema, raw)
  return parsed.success ? parsed.output : DEFAULT_REQUIREMENT_FINDING_FLOOR
}

/**
 * Lowers the floor as the task estimate rises, so a small task is asked only what blocks it and a
 * large one is asked everything. Read against the HIGHEST of the estimate's three axes
 * (complexity, risk, impact): a task that is large on any one of them is a task where a missed
 * question is expensive.
 *
 * - below `mediumFrom` the floor is `high`;
 * - from `mediumFrom` it is `medium`;
 * - from `lowFrom` it is `low`.
 *
 * With no estimate on the task the policy's fixed floor applies, and the review records that it
 * did, so a fallback never reads as a decision.
 */
export const requirementFloorProgressionSchema = v.pipe(
  v.object({
    mediumFrom: v.pipe(v.number(), v.minValue(0), v.maxValue(1)),
    lowFrom: v.pipe(v.number(), v.minValue(0), v.maxValue(1)),
  }),
  v.check((p) => p.mediumFrom <= p.lowFrom, 'mediumFrom must not exceed lowFrom'),
)
export type RequirementFloorProgression = v.InferOutput<typeof requirementFloorProgressionSchema>

/** The bands an editor offers when an operator switches a policy to progressive. */
export const DEFAULT_REQUIREMENT_FLOOR_PROGRESSION: RequirementFloorProgression = {
  mediumFrom: 0.3,
  lowFrom: 0.7,
}

/**
 * Read a stored progression back. Both facades keep it as JSON text; a value neither can parse
 * reads as "no progression" (the fixed floor) on both rather than throwing on one.
 */
export function parseRequirementFloorProgression(
  raw: string | null | undefined,
): RequirementFloorProgression | null {
  if (!raw) return null
  try {
    const parsed = v.safeParse(requirementFloorProgressionSchema, JSON.parse(raw))
    return parsed.success ? parsed.output : null
  } catch {
    return null
  }
}

/**
 * Where a review pass's floor came from:
 *
 * - `fixed`: the policy is not progressive;
 * - `estimate`: the progression read the task's estimate;
 * - `no_estimate`: the policy is progressive but the task carried no estimate, so the fixed floor
 *   applied. Kept apart from `fixed` because the remedy differs: a Task Estimator ahead of the
 *   review, not a policy edit.
 */
export const requirementFloorBasisSchema = v.picklist(['fixed', 'estimate', 'no_estimate'])
export type RequirementFloorBasis = v.InferOutput<typeof requirementFloorBasisSchema>

/** What one reviewer pass raised against, and what it left out. Recorded on the review. */
export const requirementFindingFloorRecordSchema = v.object({
  severity: reviewItemSeveritySchema,
  basis: requirementFloorBasisSchema,
  /** The estimate score (highest axis) the progression read; null unless `basis` is `estimate`. */
  score: v.nullable(v.pipe(v.number(), v.minValue(0), v.maxValue(1))),
  /** Findings the reviewer returned below the floor, which this pass dropped. */
  suppressed: v.pipe(v.number(), v.integer(), v.minValue(0)),
  /**
   * Findings a RE-REVIEW dropped for clearing neither half of the follow-up bar: not `high`, and
   * not following up on an answer the previous round gave. Null on a first pass, which has no
   * previous round to follow up on.
   */
  followUpSuppressed: v.optional(v.nullable(v.pipe(v.number(), v.integer(), v.minValue(0)))),
})
export type RequirementFindingFloorRecord = v.InferOutput<
  typeof requirementFindingFloorRecordSchema
>

/** Read a stored floor record back; an unparseable one reads as "none recorded". */
export function parseRequirementFindingFloorRecord(
  raw: string | null | undefined,
): RequirementFindingFloorRecord | null {
  if (!raw) return null
  try {
    const parsed = v.safeParse(requirementFindingFloorRecordSchema, JSON.parse(raw))
    return parsed.success ? parsed.output : null
  } catch {
    return null
  }
}

/** The policy half of the rule: the fields a risk policy carries for it. */
export interface RequirementFindingFloorPolicy {
  requirementFindingFloor: ReviewItemSeverity
  requirementFloorProgression: RequirementFloorProgression | null
}

/** The estimate half: any triage reading with the three 0..1 axes. */
export interface RequirementFloorEstimate {
  complexity: number
  risk: number
  impact: number
}

/** Resolve the floor a review pass raises against. Pure; `suppressed` is the caller's to fill. */
export function resolveRequirementFindingFloor(
  policy: RequirementFindingFloorPolicy,
  estimate: RequirementFloorEstimate | null | undefined,
): Omit<RequirementFindingFloorRecord, 'suppressed'> {
  const progression = policy.requirementFloorProgression
  if (!progression) {
    return { severity: policy.requirementFindingFloor, basis: 'fixed', score: null }
  }
  if (!estimate) {
    return { severity: policy.requirementFindingFloor, basis: 'no_estimate', score: null }
  }
  const score = Math.max(estimate.complexity, estimate.risk, estimate.impact)
  const severity: ReviewItemSeverity =
    score >= progression.lowFrom ? 'low' : score >= progression.mediumFrom ? 'medium' : 'high'
  return { severity, basis: 'estimate', score }
}

/** Whether a finding of `severity` is raised under `floor`. */
export function clearsRequirementFindingFloor(
  severity: ReviewItemSeverity,
  floor: ReviewItemSeverity,
): boolean {
  return REVIEW_ITEM_SEVERITY_RANK[severity] >= REVIEW_ITEM_SEVERITY_RANK[floor]
}
