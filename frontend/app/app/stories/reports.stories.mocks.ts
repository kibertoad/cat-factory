// Slices for the reports panel's spend breakdowns.
import type { ReportSpendRow } from '~/types/execution'

/**
 * A spend slice: `metered` billed and `subscription` illustrative, in the report's currency, over
 * `calls` calls (about nine per unit of spend by default) with tokens in proportion.
 */
export function spendRow(
  key: string,
  label: string | null,
  metered: number,
  subscription = 0,
  calls = Math.round((metered + subscription) * 9),
): ReportSpendRow {
  return {
    key,
    label,
    inputTokens: calls * 21_000,
    outputTokens: calls * 1_400,
    calls,
    meteredCost: metered,
    subscriptionCost: subscription,
  }
}
