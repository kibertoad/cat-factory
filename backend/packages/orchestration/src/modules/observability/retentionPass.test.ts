import { type RecordedLogLine, createRecordingLogger } from '@cat-factory/kernel'
import { describe, expect, it } from 'vitest'
import { createRetentionPass, materializeSpendRollup } from './retentionPass.js'

const DAY = 24 * 60 * 60_000
const NOW = 1_000 * DAY
/** The default ledger retention (`TOKEN_USAGE_RETENTION_DAYS`), which sets the catch-up horizon. */
const LEDGER_MS = 395 * DAY

// The sweep's spend-rollup step. The WALK it drives is kernel's `spendRollupWindow` (tested
// beside it, since the board-delete path folds through the same derivation); what is asserted
// here is the reporting half, which is the half that goes missing.

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
