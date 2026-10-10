import type { BudgetAlert, BudgetAlertTier } from '@cat-factory/contracts'

// The copy on a `budget_threshold` card. Pure, and separated from the sweep that raises it so
// the wording can be unit-tested against the one property it MUST have: stability.
//
// A notification is re-delivered whenever its user-visible content changes, and this card's
// condition holds for the rest of the billing period. So every figure here has to be one that
// does not move while the state is unchanged: a threshold and a limit qualify, spend-so-far and
// a projected total emphatically do not. Putting "on pace to reach 143 EUR" in the body would
// re-toast the inbox on every sweep for weeks, which is how a useful alert becomes one people
// filter away. The moving numbers belong on the Usage surface the card points at.

const TIER_PHRASE: Record<BudgetAlertTier, string> = {
  workspace: "This board's",
  account: "The account's",
}

/** The same tier, mid-sentence. */
const TIER_NOUN: Record<BudgetAlertTier, string> = {
  workspace: 'board',
  account: 'account',
}

/** The scope's stable budget facts: what the card may name without re-toasting the inbox. */
export interface SpendAlertSubject {
  /** The tier whose state drives the headline (the worst one firing). */
  tier: BudgetAlertTier
  /** The period budget, in `currency`. Stable for as long as nobody edits it. */
  costLimit: number
  /** ISO 4217 currency of `costLimit`. It travels WITH the amount, never resolved separately. */
  currency: string
  /** The highest crossed threshold as a fraction, or null when only the projection fired. */
  threshold: number | null
}

/**
 * Title + body for a `budget_threshold` card.
 *
 * `alerts` is every firing tier (so a card that concerns both says so); `subject` is the worst
 * of them, which owns the headline. A card naming only the milder tier would understate, and one
 * naming both equally would bury the fact that matters.
 */
export function spendThresholdCardContent(
  alerts: readonly BudgetAlert[],
  subject: SpendAlertSubject,
): { title: string; body: string } {
  const budget = `${formatLimit(subject.costLimit)} ${subject.currency}`
  const scope = TIER_PHRASE[subject.tier]
  const title =
    subject.threshold != null
      ? `Spend has passed ${formatPercent(subject.threshold)} of the ${TIER_NOUN[subject.tier]} budget`
      : `Spend is on pace to exceed the ${TIER_NOUN[subject.tier]} budget`

  const lead =
    subject.threshold != null
      ? `${scope} metered spend has passed ${formatPercent(subject.threshold)} of its ${budget} monthly budget.`
      : `${scope} metered spend is below its ${budget} monthly budget, but the current burn rate is projected to exceed it before the period ends.`

  // Only when the OTHER tier is firing too: a card that always listed its tiers would read as
  // boilerplate, and the single-tier case is by far the common one.
  const both = alerts.length > 1 ? ' Both the board and its account budget are affected.' : ''
  return {
    title,
    body: `${lead}${both} Raise the budget or stop what is running before runs start pausing; the Usage screen shows the burn rate and the projection.`,
  }
}

/** `0.8` → `80%`. Whole percents, because a threshold nobody can configure to 82.5% yet. */
function formatPercent(fraction: number): string {
  return `${Math.round(fraction * 100)}%`
}

/** A budget amount, trimmed of a pointless `.00` so a round limit reads as a round number. */
function formatLimit(amount: number): string {
  return Number.isInteger(amount) ? String(amount) : amount.toFixed(2)
}
