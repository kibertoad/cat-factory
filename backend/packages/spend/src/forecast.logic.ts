// Forward-looking spend: burn rate, month-end projection, and the alert state a scope is in.
//
// The spend safeguard proper (`SpendService`) is REACTIVE: it sums the period's metered
// ledger and pauses a run at the ceiling. Everything here is ADVISORY and pure: no clock,
// no repository, no LLM. It exists so a team learns it is running out while there is still
// time to raise the limit or stop a runaway, instead of learning it from a run that paused
// mid-pipeline. Nothing in this module may change gating: a projection bug must never pause
// or unpause a run.
//
// Both consumers (the alert sweep and, later, the Usage surface) go through the SAME
// functions, so what a card says and what a chart draws cannot disagree about the same
// workspace.

/** One day in ms: the unit every rate below is expressed in. */
const DAY_MS = 24 * 60 * 60 * 1000

/**
 * The trailing span the burn rate is measured over. A week smooths the working-week shape
 * (a team that runs pipelines Monday to Friday would project wildly off a Sunday sample)
 * while still reacting within a day or two to a genuine change of pace.
 *
 * Deliberately NOT the period-to-date average: on the 28th, a month-to-date rate is
 * dominated by spend from three weeks ago and barely moves when a runaway starts today,
 * which is the one moment the forecast has to earn its keep.
 */
export const BURN_RATE_WINDOW_MS = 7 * DAY_MS

/**
 * The shortest observed span a burn rate may be derived from. Under it the rate is an
 * artefact of when the sample happened to start: a workspace that spent 20 EUR in its first
 * ten minutes is not spending 2,880 EUR/day, and saying so would train people to ignore the
 * alert. Below this the forecast reports `insufficient-history` and withholds the
 * projection rather than publishing a number it cannot stand behind.
 */
export const MIN_OBSERVED_SPAN_MS = 6 * 60 * 60 * 1000

/**
 * The default fraction of the limit at which a proactive alert fires. Configurable
 * thresholds beside the budget limits are a later slice of the forecasting initiative; until
 * then every deployment alerts at the same 80%.
 */
export const DEFAULT_SPEND_ALERT_THRESHOLDS: readonly number[] = [0.8]

/**
 * Whether the projection is worth publishing.
 *
 * `insufficient-history` is a REAL state, not a zero: it says the ledger has not been
 * observed long enough for a rate to mean anything, which is a different fact from "this
 * scope is not spending". Rendering the two the same is how a brand-new runaway ends up
 * looking calm.
 */
export type SpendForecastConfidence = 'ok' | 'insufficient-history'

/** What {@link forecastSpend} needs. Every field is a fact the caller already read or holds. */
export interface SpendForecastInput {
  /** Metered spend so far in the current period, in the scope's currency. */
  costSpent: number
  /** The scope's effective limit for the period. `Infinity` ⇒ the tier is inactive. */
  costLimit: number
  /** Metered spend over the trailing window, in the same currency. */
  windowCost: number
  /**
   * Epoch ms of the OLDEST metered row inside the trailing window, or null when the window
   * holds none. It is what makes the rate honest for a scope younger than the window: without
   * it, a workspace that started spending two hours ago is divided by seven days and reads as
   * 1/84th of its real pace, understating exactly the case the alert exists for.
   */
  windowFirstSeenAt: number | null
  /** Start of the trailing window (epoch ms), i.e. `now - BURN_RATE_WINDOW_MS` by default. */
  windowStart: number
  /** Start of the current billing period (epoch ms, UTC month start). */
  periodStart: number
  /** End of the current billing period, exclusive (epoch ms): the next month start. */
  periodEnd: number
  /** The observation time (epoch ms). */
  now: number
}

/** The forward-looking half of a scope's spend position. */
export interface SpendForecast {
  /**
   * Metered spend per day over the trailing window, divided by the span actually OBSERVED
   * rather than the nominal window (see {@link SpendForecastInput.windowFirstSeenAt}). Zero
   * when nothing was spent in the window.
   */
  burnRatePerDay: number
  /**
   * Projected spend for the whole period: what is already spent plus the burn rate applied to
   * the period's remaining days. Null when {@link SpendForecast.confidence} is not `ok`: an
   * unpublishable projection is ABSENT, never a plausible-looking number.
   */
  projectedTotal: number | null
  /**
   * Epoch ms the projection expects the limit to be reached, or null when it is not expected
   * within this period (including when the limit is already reached, which is the reactive
   * safeguard's business, not the forecast's).
   */
  projectedExhaustionAt: number | null
  /** `costSpent / costLimit`, or 0 for an inactive (`Infinity`-limit) tier. */
  consumedFraction: number
  confidence: SpendForecastConfidence
}

/**
 * The forward-looking position of one scope. Pure: the same inputs always produce the same
 * forecast, which is what lets the sweep and the UI agree without sharing state.
 */
export function forecastSpend(input: SpendForecastInput): SpendForecast {
  const { costSpent, costLimit, windowCost, windowFirstSeenAt, windowStart, periodEnd, now } = input
  const consumedFraction = Number.isFinite(costLimit) && costLimit > 0 ? costSpent / costLimit : 0

  // The span the window's rows actually cover: from the older of the window's start and the
  // first row seen inside it, to now. A scope with rows spanning the whole window measures the
  // whole window; a younger one measures only as far back as it has evidence for.
  const observedFrom =
    windowFirstSeenAt == null ? windowStart : Math.max(windowStart, windowFirstSeenAt)
  const observedMs = Math.max(0, now - observedFrom)
  const burnRatePerDay = observedMs > 0 ? (windowCost / observedMs) * DAY_MS : 0

  // A scope with no metered rows in the window has a genuine, confident rate of zero. There
  // is nothing uncertain about "spent nothing all week". Short history is the uncertain case.
  const confidence: SpendForecastConfidence =
    windowFirstSeenAt != null && observedMs < MIN_OBSERVED_SPAN_MS ? 'insufficient-history' : 'ok'
  if (confidence !== 'ok') {
    return {
      burnRatePerDay,
      projectedTotal: null,
      projectedExhaustionAt: null,
      consumedFraction,
      confidence,
    }
  }

  const remainingDays = Math.max(0, periodEnd - now) / DAY_MS
  const projectedTotal = costSpent + burnRatePerDay * remainingDays
  return {
    burnRatePerDay,
    projectedTotal,
    projectedExhaustionAt: exhaustionAt(costSpent, costLimit, burnRatePerDay, now, periodEnd),
    consumedFraction,
    confidence,
  }
}

/**
 * When the limit is projected to be reached, or null when that is not expected inside this
 * period. Already-exhausted returns null on purpose: the budget gate has already acted, so a
 * forecast pointing at the past would be a second, weaker statement of a settled fact.
 */
function exhaustionAt(
  costSpent: number,
  costLimit: number,
  burnRatePerDay: number,
  now: number,
  periodEnd: number,
): number | null {
  if (!Number.isFinite(costLimit) || costSpent >= costLimit || burnRatePerDay <= 0) return null
  const at = now + ((costLimit - costSpent) / burnRatePerDay) * DAY_MS
  return at < periodEnd ? at : null
}

/**
 * The alert position of a scope in one period: the highest threshold its ACTUAL spend has
 * crossed, and whether its PROJECTION overruns the limit.
 *
 * This is the card's dedup identity, which is why it holds only state and no live figures.
 * A payload carrying the current burn rate would differ on every sweep, and the notification
 * service re-delivers a card whose content changed, so the very field that made the alert
 * informative would re-toast the inbox every few minutes for the rest of the month.
 */
export interface SpendAlertState {
  /** The period the state belongs to; a rollover re-arms every signal below. */
  periodStart: number
  /** The highest crossed threshold as a fraction (e.g. `0.8`), or null when none is crossed. */
  threshold: number | null
  /** Whether the projection exceeds the limit while actual spend has not yet reached it. */
  projectedOverrun: boolean
}

/**
 * The alert state implied by a forecast. `thresholds` are fractions of the limit; an empty
 * list (or an inactive tier) yields a state that fires nothing.
 *
 * `projectedOverrun` is deliberately suppressed once the limit is ALREADY reached: at that
 * point the projection is no longer a warning about the future, and the reactive safeguard
 * owns the message. It is likewise suppressed when the projection is unpublishable, because
 * "we cannot forecast this yet" must not be reported as "you are fine".
 */
export function spendAlertState(
  forecast: SpendForecast,
  periodStart: number,
  costLimit: number,
  thresholds: readonly number[] = DEFAULT_SPEND_ALERT_THRESHOLDS,
): SpendAlertState {
  if (!Number.isFinite(costLimit) || costLimit <= 0) {
    return { periodStart, threshold: null, projectedOverrun: false }
  }
  const crossed = thresholds.filter((t) => t > 0 && forecast.consumedFraction >= t)
  const projectedOverrun =
    forecast.confidence === 'ok' &&
    forecast.projectedTotal != null &&
    forecast.consumedFraction < 1 &&
    forecast.projectedTotal > costLimit
  return {
    periodStart,
    threshold: crossed.length > 0 ? Math.max(...crossed) : null,
    projectedOverrun,
  }
}

/** Whether an alert state says anything at all (nothing crossed, nothing projected ⇒ no card). */
export function spendAlertFiring(state: SpendAlertState): boolean {
  return state.threshold != null || state.projectedOverrun
}

/**
 * The signals one tier contributes to a fold: {@link SpendAlertState} minus the period, which
 * belongs to the scope rather than to any one tier.
 */
export type SpendAlertSignals = Pick<SpendAlertState, 'threshold' | 'projectedOverrun'>

/**
 * Fold the per-tier states a scope is in into the ONE state {@link spendAlertEscalated} compares:
 * the highest threshold any tier crossed, and whether any tier projects an overrun.
 *
 * BOTH sides of that comparison must come from here. A card lists every tier that was firing when
 * it was raised, so pitting it against a single tier's state is not a stricter test but a
 * different one, and it loses real warnings: an account tier that newly starts projecting an
 * overrun beside a workspace tier already sitting at 80% moves the fold and leaves the worst tier
 * untouched, so the card is never re-raised and the account's overrun is never announced. Folding
 * both sides through one function is what makes that asymmetry impossible to reintroduce.
 */
export function mergeSpendAlertStates(
  periodStart: number,
  tiers: readonly SpendAlertSignals[],
): SpendAlertState {
  let threshold: number | null = null
  let projectedOverrun = false
  for (const tier of tiers) {
    if (tier.threshold != null && (threshold == null || tier.threshold > threshold)) {
      threshold = tier.threshold
    }
    projectedOverrun ||= tier.projectedOverrun
  }
  return { periodStart, threshold, projectedOverrun }
}

/**
 * Whether `next` is an ESCALATION over what was last notified: the once-per-crossing rule.
 *
 * Only an upward move earns a fresh notification: a new period re-arms everything, a higher
 * threshold is news, and a projection that has newly turned to overrun is news. Staying at
 * 80% for three weeks is not, and neither is falling back from 80% to nothing, because
 * un-crossing a threshold is not something anyone needs to be told about.
 *
 * A null `previous` means nothing has been notified for this scope yet, so any firing state
 * escalates.
 *
 * Both arguments must be folds over the SAME tier set (see {@link mergeSpendAlertStates}).
 */
export function spendAlertEscalated(
  previous: SpendAlertState | null,
  next: SpendAlertState,
): boolean {
  if (!spendAlertFiring(next)) return false
  if (!previous || previous.periodStart !== next.periodStart) return true
  if ((next.threshold ?? 0) > (previous.threshold ?? 0)) return true
  return next.projectedOverrun && !previous.projectedOverrun
}
