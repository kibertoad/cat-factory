import type { ReportActivityRow, ReportSpendRow, ReportTrendPoint } from '~/types/execution'

// Pure sizing/derivation behind `ReportsPanel.vue`: everything the template needs that is
// arithmetic rather than markup, so it is unit-tested directly instead of through the DOM.

// The two `*Magnitude` helpers add the metered and subscription costs together, which is a
// number NOBODY MAY RENDER AS MONEY: only `meteredCost` is real spend, and `subscriptionCost`
// is the illustrative equivalent-API cost of flat-rate quota usage, so their sum denominates
// nothing. They exist purely as the RANKING and BAR-SCALING measure — the one job the sum is
// valid for, because it orders slices by total footprint exactly as the SQL `ORDER BY` does.
// Anything shown to a reader with a currency symbol must come off one of the two fields.

/** A spend slice's combined footprint. Ranking/scaling only — never a displayed amount. */
export function spendMagnitude(row: ReportSpendRow): number {
  return row.meteredCost + row.subscriptionCost
}

/** A trend bucket's combined footprint. Ranking/scaling only — never a displayed amount. */
export function trendMagnitude(point: ReportTrendPoint): number {
  return point.meteredCost + point.subscriptionCost
}

/**
 * The heaviest value in a list, or 0 when empty. Bars are drawn RELATIVE to this, so a
 * full bar means "the biggest slice here", never "all of some absolute quota".
 */
export function maxOf<T>(rows: T[], measure: (row: T) => number): number {
  return rows.reduce((max, row) => Math.max(max, measure(row)), 0)
}

/**
 * A segment's share of the widest row, as a percentage. Scaling every segment against the
 * SAME denominator is what makes a stacked bar's total length comparable across rows; a
 * per-row denominator would draw every bar full-width and destroy the ranking.
 */
export function segmentPct(value: number, max: number): number {
  if (max <= 0 || value <= 0) return 0
  return (value / max) * 100
}

/**
 * A trend column's height as a percentage of the tallest column. A non-zero value floors at
 * 2% so a single small call is still a visible mark rather than an apparent gap — the one
 * thing a reader would otherwise misread as "nothing happened here".
 */
export function columnPct(value: number, max: number): number {
  if (max <= 0 || value <= 0) return 0
  return Math.max(2, (value / max) * 100)
}

/**
 * Whether a breakdown key is the unattributed bucket. It is a REAL slice (a call whose run,
 * service or task type could not be resolved), so it is rendered with an explicit label
 * rather than silently dropped — omitting it would under-report the window while looking
 * complete.
 */
export function isUnattributed(key: string): boolean {
  return key === ''
}

/** Every status split of an activity row, in the fixed order the legend declares. */
export function activitySegments(
  row: ReportActivityRow,
): Array<{ status: 'done' | 'failed' | 'running' | 'other'; count: number }> {
  return [
    { status: 'done', count: row.done },
    { status: 'failed', count: row.failed },
    { status: 'running', count: row.running },
    { status: 'other', count: row.other },
  ]
}
