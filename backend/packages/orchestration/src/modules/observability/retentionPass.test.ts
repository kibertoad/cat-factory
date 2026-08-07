import { type RecordedLogLine, createRecordingLogger } from '@cat-factory/kernel'
import { describe, expect, it } from 'vitest'
import {
  SPEND_DAY_ROLLUP_BACKFILL_MS,
  SPEND_DAY_ROLLUP_LOOKBACK_MS,
  SPEND_DAY_ROLLUP_MAX_SPAN_MS,
  createRetentionPass,
  materializeSpendRollup,
  spendRollupWindow,
} from './retentionPass.js'

const DAY = 24 * 60 * 60_000
const NOW = 1_000 * DAY
/** The default ledger retention (`TOKEN_USAGE_RETENTION_DAYS`), which sets the catch-up horizon. */
const LEDGER_MS = 395 * DAY

// The durable spend rollup's catch-up walk. It is the one rollup whose missed pass is
// PERMANENT (nothing else retains the attribution it folds), which is why it resumes from the
// sweep's watermark instead of recomputing a fixed trailing window like the run rollup.

describe('spendRollupWindow', () => {
  it('backfills the longest report window when no pass has ever run', () => {
    // Starting at "today" would under-report the 90-day window for a quarter while looking
    // complete: the ledger has the data, and nothing would show it had not been asked for.
    const { from } = spendRollupWindow(null, NOW, LEDGER_MS)
    expect(from).toBe(NOW - SPEND_DAY_ROLLUP_BACKFILL_MS)
  })

  it('caps one pass at the max span so a wide catch-up is several queries, not one huge one', () => {
    const { from, to } = spendRollupWindow(null, NOW, LEDGER_MS)
    expect(to - from).toBe(SPEND_DAY_ROLLUP_MAX_SPAN_MS)
    // …and the next pass continues from where this one stopped, so the walk converges.
    const next = spendRollupWindow(to - DAY, NOW, LEDGER_MS)
    expect(next.from).toBe(to - DAY)
  })

  it('recomputes the trailing lookback once caught up', () => {
    // A day that was still accruing when it was covered has to be corrected, not frozen
    // half-counted, so the steady state re-folds the last few days on every pass.
    const { from, to } = spendRollupWindow(NOW, NOW, LEDGER_MS)
    expect(from).toBe(NOW - SPEND_DAY_ROLLUP_LOOKBACK_MS)
    expect(to).toBe(NOW)
  })

  it('resumes from a stale watermark rather than skipping the days it missed', () => {
    const { from } = spendRollupWindow(NOW - 10 * DAY, NOW, LEDGER_MS)
    expect(from).toBe(NOW - 10 * DAY)
  })

  it('catches up over days the LEDGER still holds, past the first-pass backfill horizon', () => {
    // The regression this pins. The backfill constant bounds how much history a deployment
    // ADOPTS on its first pass, which is a judgement call; it is not a statement about a
    // deployment that already committed to recording these days and then had its sweep go
    // down. Reusing it as the catch-up horizon stepped over months of days the ledger was
    // still holding, and the high-water mark then advanced straight past the hole.
    const stale = NOW - 200 * DAY
    const { from, skipped } = spendRollupWindow(stale, NOW, LEDGER_MS)
    expect(from).toBe(stale)
    expect(skipped).toBeNull()
  })

  it('stops at the ledger retention edge, where there is genuinely nothing left to fold', () => {
    // Past its own retention the ledger has been pruned, so these days are unrecoverable
    // rather than merely skipped, and the caller is TOLD: a high-water mark cannot represent
    // a hole, so nothing downstream will ever restate it.
    const ancient = NOW - 3 * LEDGER_MS
    const { from, skipped } = spendRollupWindow(ancient, NOW, LEDGER_MS)
    expect(from).toBe(NOW - LEDGER_MS)
    expect(skipped).toEqual({ from: ancient, to: NOW - LEDGER_MS })
  })

  it('falls back to the backfill horizon when the ledger is never pruned', () => {
    // A non-positive window disables the ledger prune, so there is no retention edge to
    // derive a horizon from; the backfill constant is the floor, and the drop is still named.
    const { from, skipped } = spendRollupWindow(NOW - 5 * SPEND_DAY_ROLLUP_BACKFILL_MS, NOW, 0)
    expect(from).toBe(NOW - SPEND_DAY_ROLLUP_BACKFILL_MS)
    expect(skipped?.to).toBe(NOW - SPEND_DAY_ROLLUP_BACKFILL_MS)
  })

  it('reports no skip on a FIRST pass, whose horizon is a choice rather than a loss', () => {
    // A null watermark means the deployment never committed to these days at all, so the
    // backfill cut is deliberate scope, not a gap. Reporting it would train an operator to
    // ignore the one line that names real data loss.
    expect(spendRollupWindow(null, NOW, LEDGER_MS).skipped).toBeNull()
  })

  it('never rolls up past now, even from a future-dated watermark', () => {
    const { from, to } = spendRollupWindow(NOW + 30 * DAY, NOW, LEDGER_MS)
    expect(from).toBe(NOW - SPEND_DAY_ROLLUP_LOOKBACK_MS)
    expect(to).toBe(NOW)
  })
})

describe('materializeSpendRollup', () => {
  const repo = (watermark: number | null) => {
    const windows: Array<{ from: number; to: number }> = []
    return {
      windows,
      spendRollupWatermark: () => Promise.resolve(watermark),
      rollupSpendDays: (from: number, to: number) => {
        windows.push({ from, to })
        return Promise.resolve(7)
      },
    }
  }

  it('materialises the walked window and stays quiet when nothing was given up', async () => {
    const lines: RecordedLogLine[] = []
    const store = repo(NOW - 10 * DAY)
    const written = await materializeSpendRollup(
      createRetentionPass(),
      store,
      NOW,
      LEDGER_MS,
      createRecordingLogger(lines),
    )
    expect(written).toBe(7)
    expect(store.windows).toEqual([{ from: NOW - 10 * DAY, to: NOW }])
    expect(lines).toEqual([])
  })

  it('NAMES a permanently skipped span, which nothing else in the system can', async () => {
    // The only notice this loss ever gets. `through_day` is a high-water mark, so the next
    // pass advances straight over the hole and every later read of the rollup describes it as
    // continuous. A silent skip here is indistinguishable from a quarter nobody spent
    // anything in, which is the precise confusion this table was built to end.
    const lines: RecordedLogLine[] = []
    await materializeSpendRollup(
      createRetentionPass(),
      repo(NOW - 3 * LEDGER_MS),
      NOW,
      LEDGER_MS,
      createRecordingLogger(lines),
    )
    expect(lines).toHaveLength(1)
    expect(lines[0]?.level).toBe('warn')
    expect(lines[0]?.fields).toMatchObject({
      table: 'spend_days',
      skippedFrom: NOW - 3 * LEDGER_MS,
      skippedTo: NOW - LEDGER_MS,
      skippedDays: 2 * 395,
    })
  })

  it('reports a throwing rollup as a failed table rather than aborting the sweep', async () => {
    const pass = createRetentionPass()
    const written = await materializeSpendRollup(
      pass,
      {
        spendRollupWatermark: () => Promise.resolve(NOW),
        rollupSpendDays: () => Promise.reject(new Error('d1 row limit')),
      },
      NOW,
      LEDGER_MS,
    )
    expect(written).toBe(0)
    expect(pass.failed).toEqual(['spend_days'])
  })
})
