import { describe, expect, it } from 'vitest'
import {
  SPEND_DAY_ROLLUP_BACKFILL_MS,
  SPEND_DAY_ROLLUP_LOOKBACK_MS,
  SPEND_DAY_ROLLUP_MAX_SPAN_MS,
  spendRollupWindow,
} from './retentionPass.js'

const DAY = 24 * 60 * 60_000
const NOW = 1_000 * DAY

// The durable spend rollup's catch-up walk. It is the one rollup whose missed pass is
// PERMANENT (nothing else retains the attribution it folds), which is why it resumes from the
// sweep's watermark instead of recomputing a fixed trailing window like the run rollup.

describe('spendRollupWindow', () => {
  it('backfills the longest report window when no pass has ever run', () => {
    // Starting at "today" would under-report the 90-day window for a quarter while looking
    // complete: the ledger has the data, and nothing would show it had not been asked for.
    const { from } = spendRollupWindow(null, NOW)
    expect(from).toBe(NOW - SPEND_DAY_ROLLUP_BACKFILL_MS)
  })

  it('caps one pass at the max span so a wide catch-up is several queries, not one huge one', () => {
    const { from, to } = spendRollupWindow(null, NOW)
    expect(to - from).toBe(SPEND_DAY_ROLLUP_MAX_SPAN_MS)
    // …and the next pass continues from where this one stopped, so the walk converges.
    const next = spendRollupWindow(to - DAY, NOW)
    expect(next.from).toBe(to - DAY)
  })

  it('recomputes the trailing lookback once caught up', () => {
    // A day that was still accruing when it was covered has to be corrected, not frozen
    // half-counted, so the steady state re-folds the last few days on every pass.
    const { from, to } = spendRollupWindow(NOW, NOW)
    expect(from).toBe(NOW - SPEND_DAY_ROLLUP_LOOKBACK_MS)
    expect(to).toBe(NOW)
  })

  it('resumes from a stale watermark rather than skipping the days it missed', () => {
    const { from } = spendRollupWindow(NOW - 10 * DAY, NOW)
    expect(from).toBe(NOW - 10 * DAY)
  })

  it('never walks back past the backfill horizon, whatever the watermark claims', () => {
    // A hand-edited or restored-from-backup marker must not turn one cron pass into a scan of
    // the whole ledger.
    const { from } = spendRollupWindow(NOW - 5 * SPEND_DAY_ROLLUP_BACKFILL_MS, NOW)
    expect(from).toBe(NOW - SPEND_DAY_ROLLUP_BACKFILL_MS)
  })

  it('never rolls up past now, even from a future-dated watermark', () => {
    const { from, to } = spendRollupWindow(NOW + 30 * DAY, NOW)
    expect(from).toBe(NOW - SPEND_DAY_ROLLUP_LOOKBACK_MS)
    expect(to).toBe(NOW)
  })
})
