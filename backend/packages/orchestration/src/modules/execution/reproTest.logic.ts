import { type ReproTestOutcome, reproTestOutcome } from '@cat-factory/agents'
import { renderStructuredDigest } from './structuredDigest.logic.js'

// Pure rendering for the `repro-test` post-completion resolver: fold its STRUCTURED outcome
// (`result.custom`, the `reproTestOutcome` schema) into a short prose digest that lands on
// `step.output`. Downstream steps read only `step.output` via `priorOutputs` (the coder), so
// this digest is how the reproduction result reaches them; the raw structured object stays on
// `step.custom` for the `generic-structured` result view. Returns `undefined` for an
// unparseable/empty result so the resolver leaves the agent's raw reply on `step.output`.

/**
 * Human-readable heading for each reproduction outcome, typed over the closed picklist so the
 * lookup is total and the compiler refuses a new verdict until it has a heading.
 */
const OUTCOME_LABEL: Record<ReproTestOutcome['outcome'], string> = {
  reproduced: 'Reproduced: a failing test was committed',
  partial: 'Partially reproduced',
  not_reproducible: 'Not reproducible: no failing test was committed',
}

/** Render a repro-test's structured outcome into a human-readable digest, or undefined. */
export function renderReproDigest(custom: unknown): string | undefined {
  const parsed = reproTestOutcome.safeParse(custom)
  if (!parsed) return undefined
  return renderStructuredDigest({
    heading: 'Reproduction test',
    headline: OUTCOME_LABEL[parsed.outcome],
    sections: [{ heading: 'Tests', values: parsed.testPaths, code: true }],
    notes: parsed.notes,
  })
}
