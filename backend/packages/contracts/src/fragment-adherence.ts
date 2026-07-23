import * as v from 'valibot'

// ---------------------------------------------------------------------------
// Best-practice adherence wire contract. A code/PR review agent is asked to
// report, per best-practice prompt fragment (ADR 0006) that was folded into its
// prompt, how well the reviewed object adheres to that standard — a 1..10 rating
// plus the concrete issues the standard surfaced. It rides the review agent's
// structured output, is recorded on the review step (`PipelineStep.fragmentAdherence`),
// and is surfaced in run details / the PR-review window. Lenient by construction (a
// partial/absent report degrades to safe defaults) so a malformed self-report never
// fails an otherwise-successful review.
// ---------------------------------------------------------------------------

/**
 * One best-practice standard (prompt fragment) a review agent assessed the reviewed
 * object against. The agent refers to the standard by its `title` (the label it was
 * asked to cite) and keeps `fragmentId` so the rating can be matched back to the folded
 * standard. `rating` is 1 (the object flatly violates the standard) .. 10 (it fully
 * adheres); `relatedFindings` names the specific issues this standard drove, when any.
 */
export const fragmentAdherenceItemSchema = v.object({
  /** Stable fragment id the rating concerns (matches a folded standard's id), when the agent kept it. */
  fragmentId: v.fallback(v.optional(v.string()), undefined),
  /** The standard's human title — the label the agent was asked to cite it by. */
  title: v.fallback(v.optional(v.string()), undefined),
  /** How well the reviewed object adheres to this standard: 1 (violates it) .. 10 (fully adheres). */
  rating: v.fallback(v.pipe(v.number(), v.minValue(1), v.maxValue(10)), 5),
  /** Prose justification of the rating. */
  assessment: v.fallback(v.string(), ''),
  /** Short references (titles / one-liners) to the specific issues this standard surfaced, when any. */
  relatedFindings: v.fallback(v.array(v.string()), []),
})
export type FragmentAdherenceItem = v.InferOutput<typeof fragmentAdherenceItemSchema>

/** A review agent's per-standard adherence assessment (empty when no standards were reachable). */
export const fragmentAdherenceSchema = v.array(fragmentAdherenceItemSchema)
export type FragmentAdherence = v.InferOutput<typeof fragmentAdherenceSchema>

/** Non-throwing parse of a fragment-adherence list the model returned; `undefined` when unusable. */
export function safeParseFragmentAdherence(value: unknown): FragmentAdherence | undefined {
  const result = v.safeParse(fragmentAdherenceSchema, value)
  return result.success ? result.output : undefined
}
