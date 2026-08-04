// Which PRE-DISPATCH INPUT GATE verdicts a run surfaces, and how they are presented.
//
// The gate records a verdict for EVERY disposition, including the ones where it did nothing, so
// "has a verdict" is not the same question as "has something to tell a human". This is the one
// place that answers the second one, because the run panel and the step-detail overlay both ask
// it and a per-component `status === 'blocked'` check is how they drift.

import type { ExecutionInstance } from '~/types/execution'
import type { RunInputGate } from '@cat-factory/contracts'

/**
 * How a verdict reads to a human:
 *
 *  - `blocked`: the run is parked, and the notice carries the two ways out.
 *  - `waived`: somebody read the blocking findings and ran anyway. Kept visible on the run that
 *    carries it, because what was overruled is part of what explains the output.
 *  - `advisory`: findings were recorded and nothing was parked. This is the whole point of
 *    `advisory` MODE ("watch what the gate would have caught before turning it up"), and it is
 *    also how `standard` mode reports a short description or a spike with no success criteria.
 */
export type InputGateTone = 'blocked' | 'waived' | 'advisory'

/**
 * The verdict a run should show, with the tone to show it in, or `null` when the gate has
 * nothing to say.
 *
 * Nothing to say covers three real and different facts that happen to share a presentation:
 * a verdict that has not been stamped yet, one the workspace turned `off`, and a clean `passed`.
 * None of them is a message, so none of them earns a box on the panel. The distinction between
 * them is preserved on the run and read by the API, not painted over here.
 *
 * Note what this deliberately does NOT gate on: a `passed` status. A `passed` verdict carrying
 * advisories is exactly what advisory mode produces, and keying the notice off the status alone
 * left every advisory finding recorded, reported over the API, and invisible in the product.
 */
export function inputGateNoticeFor(
  instance: ExecutionInstance | null | undefined,
): { gate: RunInputGate; tone: InputGateTone } | null {
  const gate = instance?.inputGate
  if (!gate) return null
  if (gate.status === 'blocked') return { gate, tone: 'blocked' }
  if (gate.status === 'overridden') return { gate, tone: 'waived' }
  return gate.issues.length > 0 ? { gate, tone: 'advisory' } : null
}
