// Pure inference of a task's BUSINESS-vs-TECHNICAL label from the spec phase.
//
// The spec-writer determines whether a task is purely technical (it produces NO business
// specs — `noBusinessSpecs`), and the spec-companion corroborates or disputes that
// determination (`technicalCorroborated`). Those two signals coexist exactly once: when
// the spec-companion CONVERGES (passes). This function turns them into the inferred
// `technical` label, honouring the rule that a human-set value is authoritative and is
// NEVER overridden by the engine.

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
 *  - A concrete existing label (`true`/`false`) is authoritative — return `undefined`
 *    (never override a human's, or an already-settled, choice).
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
