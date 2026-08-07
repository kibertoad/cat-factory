import { describe, expect, it } from 'vitest'
import {
  SPEND_DAY_ROLLUP_BACKFILL_MS,
  SPEND_DAY_ROLLUP_LOOKBACK_MS,
  SPEND_DAY_ROLLUP_MAX_SPAN_MS,
  finalSpendFoldPlan,
  spendRollupWindow,
} from './spend-rollup-window.js'

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

// The board's LAST fold, run inside its own deletion. Same resume point and same horizon as the
// sweep's pass, and one difference that is the whole reason it is a separate plan: there is no
// next pass to leave a remainder to.

describe('finalSpendFoldPlan', () => {
  it('starts where the sweep would have resumed', () => {
    // Not "since the last complete day": the sweep's own lookback is what corrects a day that
    // was still accruing when it was covered, and the board's final hours are exactly such a day.
    expect(finalSpendFoldPlan(NOW, NOW, LEDGER_MS).spans).toEqual([
      { from: NOW - SPEND_DAY_ROLLUP_LOOKBACK_MS, to: NOW },
    ])
  })

  it('CHUNKS a wide catch-up instead of truncating it, because nothing folds these days later', () => {
    // The sweep caps its window and picks the rest up next pass. A board being deleted has no
    // next pass and its ledger rows go with the cascade, so the cap has to become a chunk size:
    // the bound exists to keep one GROUP BY sane, which sequential queries satisfy too.
    const stale = NOW - 70 * DAY
    const { spans } = finalSpendFoldPlan(stale, NOW, LEDGER_MS)
    expect(spans[0]?.from).toBe(stale)
    expect(spans.at(-1)?.to).toBe(NOW)
    for (const span of spans) {
      expect(span.to - span.from).toBeLessThanOrEqual(SPEND_DAY_ROLLUP_MAX_SPAN_MS)
    }
    // Contiguous, so the walk has no seam of its own making.
    for (const [i, span] of spans.slice(1).entries()) expect(span.from).toBe(spans[i]?.to)
  })

  it('reports the same unfoldable span the sweep does, and nothing more', () => {
    // Past the ledger's retention there is nothing left to fold anywhere, so this loss predates
    // the delete rather than being caused by it. Everything inside the horizon IS covered.
    const ancient = NOW - 3 * LEDGER_MS
    const { spans, skipped } = finalSpendFoldPlan(ancient, NOW, LEDGER_MS)
    expect(skipped).toEqual({ from: ancient, to: NOW - LEDGER_MS })
    expect(spans[0]?.from).toBe(NOW - LEDGER_MS)
    expect(spans.at(-1)?.to).toBe(NOW)
  })

  it('never plans an empty or inverted span, whatever the watermark says', () => {
    // A fold of `[to, from)` would DELETE a day window and re-fold nothing into it, and the
    // window it deletes belongs to a board that is on its way out: the one place this table
    // cannot heal from. A future-dated watermark (hand-edited, a restored backup, clock skew)
    // is the input that reaches for it, and it still lands on the trailing lookback.
    for (const watermark of [null, NOW + 30 * DAY, NOW, NOW - 400 * DAY]) {
      const { spans } = finalSpendFoldPlan(watermark, NOW, LEDGER_MS)
      expect(spans.length).toBeGreaterThan(0)
      for (const span of spans) expect(span.to).toBeGreaterThan(span.from)
      expect(spans.at(-1)?.to).toBe(NOW)
    }
  })
})
