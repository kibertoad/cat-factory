// What the outcome card's environment rows say once a CLOCK is applied to them, extracted from
// `OutcomeSummaryWindow.vue` so the rule can be asserted without mounting the card (see
// `OutcomeSummaryWindow.logic.spec.ts`).
//
// The reduction that produces those rows (`composeRunOutcome`) is deliberately clock-free: the
// SPA composes it live off its own store and `GET /api/v1/runs/:runId/outcome` composes it
// server-side, and a rule that read a clock would let the two disagree about one run for as long
// as their clocks differ. What the payload carries instead is the TTL INSTANT.
//
// Somebody still has to say what that instant means now, and it has to be the surface with the
// clock. Left unapplied, a run whose environment the TTL sweep reclaimed hours ago renders a
// green "Live" badge and an enabled Open button beside an expiry date in the past: three claims
// on one row, of which the date is the only true one.

import type { OutcomeEnvironment, OutcomeEnvironmentState } from '~/utils/runOutcome'

/**
 * The states that describe an environment still STANDING, and so the only ones a lapsed TTL
 * changes what they say.
 *
 * `failed`, `reclaimed` and `reclaiming` already name where the environment went or what is
 * happening to it. A clock may not overwrite those with a less specific word: an environment
 * that never came up did not then expire, and saying so would send a reader looking for a TTL
 * where a provisioning failure is the thing to fix.
 */
const STANDING_ENVIRONMENT_STATES = new Set<OutcomeEnvironmentState>(['live', 'provisioning'])

/** One environment row as the card renders it: the payload's own fields, read against a clock. */
export interface OutcomeEnvironmentRow extends OutcomeEnvironment {
  /** True when the row's TTL has lapsed against `nowMs` while it still claimed to be standing. */
  lapsed: boolean
  /** Whether the card offers the row as something to click. */
  openable: boolean
}

/**
 * Apply the reader's clock to one environment row.
 *
 * `nowMs` of 0 means the card has not ticked yet (`useNowTick` reads 0 until mounted). No clock
 * means no clock-derived claim: the row reads exactly as the payload states it rather than
 * having every TTL lapse against the epoch.
 */
export function readEnvironmentAgainstClock(
  entry: OutcomeEnvironment,
  nowMs: number,
): OutcomeEnvironmentRow {
  const lapsed =
    nowMs > 0 &&
    entry.expiresAt != null &&
    entry.expiresAt <= nowMs &&
    STANDING_ENVIRONMENT_STATES.has(entry.state)
  const state = lapsed ? 'expired' : entry.state
  return {
    ...entry,
    state,
    lapsed,
    // A link is offered ONLY for a `live` row: an environment that has been reclaimed, has
    // expired or never came up still shows its URL (an operator greps for it, and it says which
    // environment the row is about) and must not be something a designer clicks expecting to see
    // the change.
    openable: state === 'live' && Boolean(entry.url),
  }
}
