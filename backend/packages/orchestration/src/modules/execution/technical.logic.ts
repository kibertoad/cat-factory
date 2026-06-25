// Pure inference of a task's BUSINESS-vs-TECHNICAL label from the spec phase.
//
// The spec-writer determines whether a task is purely technical (it produces NO business
// specs — `noBusinessSpecs`), and the spec-companion corroborates or disputes that
// determination (`technicalCorroborated`). Both signals are persisted on their steps, so
// the engine can run this inference when the spec-companion CONVERGES (passes) AND when a
// human PROCEEDS past the companion's iteration cap.
//
// Authority/stability rule: once a concrete label is recorded it is frozen — this function
// returns `undefined` (no change) for any existing `true`/`false`, whether it was set by a
// human or by a prior inference. A human-set value is thus never overridden by the engine,
// and an inferred value is not silently flip-flopped on a re-run either; to re-open a task
// to inference a human clears the label back to "unset" (`null`) via the inspector toggle.

/**
 * Decide the `technical` label to persist on a block from the spec phase, or `undefined`
 * to leave the block untouched.
 *
 * @param currentTechnical the block's stored label (`true`/`false` = a determination is
 *   already recorded — by a human or a prior inference; `null`/`undefined` = not yet
 *   determined).
 * @param producerNoBusinessSpecs whether the spec-writer produced no business specs.
 * @param technicalCorroborated the spec-companion's corroboration verdict (`undefined` ⇒
 *   the companion gave no opinion).
 * @returns the boolean to persist, or `undefined` to make no change.
 *
 * Rules:
 *  - A concrete existing label (`true`/`false`) is authoritative and frozen — return
 *    `undefined` (never override a human's, or an already-settled inferred, choice; a human
 *    re-opens it by clearing the label to `null`).
 *  - With no companion opinion (`technicalCorroborated === undefined`) infer nothing.
 *  - Otherwise the label is `noBusinessSpecs && technicalCorroborated`: a task is technical
 *    only when the writer produced no business specs AND the companion agrees. Specs
 *    produced (or a dispute) ⇒ `false` (the symmetric business case).
 */
export function inferTechnicalLabel(
  currentTechnical: boolean | null | undefined,
  producerNoBusinessSpecs: boolean,
  technicalCorroborated: boolean | undefined,
): boolean | undefined {
  if (typeof currentTechnical === 'boolean') return undefined
  if (technicalCorroborated === undefined) return undefined
  return producerNoBusinessSpecs && technicalCorroborated
}
