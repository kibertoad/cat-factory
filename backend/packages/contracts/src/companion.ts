import * as v from 'valibot'
import { stepReviewCommentSchema } from './entities.js'

// ---------------------------------------------------------------------------
// Companion-agent wire contracts. A companion agent reviews the outcome of an
// immediately-preceding producer step (e.g. an architect design, a spec's
// acceptance scenarios, or a coder's change), challenges its quality and
// completeness, and returns a single overall quality rating in 0..1 plus
// actionable feedback. The execution engine compares the rating against the
// step's configured threshold (default 0.8): at or above it the run proceeds to
// the human gate / next step; below it the producer step is re-run with the
// companion's feedback folded in, and once the rework budget is exhausted the step
// parks on a human iteration-cap gate (one more round / proceed anyway / stop & reset)
// instead of failing.
// ---------------------------------------------------------------------------

/** The default quality bar a companion's rating must reach for the run to proceed. */
export const DEFAULT_COMPANION_THRESHOLD = 0.8

/** The default number of automatic rework attempts before a companion parks for a human. */
export const DEFAULT_COMPANION_MAX_ATTEMPTS = 3

/**
 * A companion agent's structured assessment of the producer step's output. `rating`
 * is the single overall quality score (0..1, higher = better); `summary` is the
 * prose justification surfaced to the human and folded into a rework; `comments`
 * optionally anchor specific challenges to individual items (by `anchorId`) or prose
 * ranges, reusing the shared step-review comment shape.
 */
export const companionAssessmentSchema = v.object({
  /** Overall quality of the reviewed outcome (0..1, higher = better). */
  rating: v.pipe(v.number(), v.minValue(0), v.maxValue(1)),
  /** Plain-prose justification of the rating + the changes the producer should make. */
  summary: v.string(),
  /** Optional per-item / per-block challenges (shared shape with human reviews). */
  comments: v.optional(v.array(stepReviewCommentSchema)),
  /**
   * The spec-companion's corroboration of the spec-writer's BUSINESS-vs-TECHNICAL
   * determination: `true` when it agrees the task is purely technical and correctly
   * produced no business specs, `false` when business specs were the right call.
   * Absent ⇒ no opinion (the engine then infers nothing). Only the spec-companion sets
   * it; other companions omit it. Read by the engine — together with the writer's
   * `noBusinessSpecs` signal — to infer the block's `technical` label.
   */
  technicalCorroborated: v.optional(v.boolean()),
})
export type CompanionAssessment = v.InferOutput<typeof companionAssessmentSchema>

/** Parse-or-throw a companion assessment payload the model returned (the engine validates it). */
export function parseCompanionAssessment(value: unknown): CompanionAssessment {
  return v.parse(companionAssessmentSchema, value)
}

/** Non-throwing variant: returns the parsed assessment or `undefined` when invalid. */
export function safeParseCompanionAssessment(value: unknown): CompanionAssessment | undefined {
  const result = v.safeParse(companionAssessmentSchema, value)
  return result.success ? result.output : undefined
}
