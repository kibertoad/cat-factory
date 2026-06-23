import * as v from 'valibot'

// ---------------------------------------------------------------------------
// Shared contract for an iterative agent gate that hit its budget. Two engine
// gates loop an agent + a human until the agent converges: the requirements
// reviewer (bounded by `maxRequirementIterations`) and the quality companions
// (reviewer / spec-companion / architect-companion, bounded by their automatic
// rework budget). When either spends its budget with the bar still unmet, it
// parks for a human instead of getting stuck, offering the SAME three choices.
// This module is the single source of truth for those choices so both gates
// (and both runtime facades) can't drift.
// ---------------------------------------------------------------------------

/**
 * How a human resolves an iterative gate that hit its budget with the bar still
 * unmet:
 * - `extra-round`: grant one more agent pass (bumps the budget by one).
 * - `proceed`: advance the pipeline accepting the latest output as-is.
 * - `stop-reset`: cancel the run and return the task to phase zero (editable),
 *   keeping the latest produced artifact as a reference to rework from.
 */
export const iterationCapChoiceSchema = v.picklist(['extra-round', 'proceed', 'stop-reset'])
export type IterationCapChoice = v.InferOutput<typeof iterationCapChoiceSchema>

/** Request body carrying an {@link iterationCapChoiceSchema} choice. */
export const resolveIterationCapSchema = v.object({
  choice: iterationCapChoiceSchema,
})
export type ResolveIterationCapInput = v.InferOutput<typeof resolveIterationCapSchema>
