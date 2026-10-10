import {
  type Logger,
  type SpendRollupRepository,
  describeError,
  spendRollupWindow,
} from '@cat-factory/kernel'

// Per-table isolation for the retention sweeps (docs/initiatives/observability-logging-gaps.md,
// C6 / slice 4.4), shared by both facades so the two cannot drift.
//
// Both sweeps were a chain of sequential `await`s inside one implicit try: the FIRST failing
// `deleteOlderThan` aborted every later prune in the pass, and did so on every pass thereafter,
// so one sick table silently stopped ALL telemetry pruning — indefinitely, behind a single
// generic "sweep failed" line that named neither the table nor the cause. The tables that grow
// fastest (`llm_call_metrics` with full prompt/response bodies, the agent-context snapshots)
// are late in the chain, which is the worst possible ordering for that failure mode.
//
// Isolation alone is not the whole fix. A pass that swallows a per-table failure and returns
// zeroes reads exactly like a pass that had nothing to reclaim, so the pass also has to REPORT
// which tables it could not prune — `failed` is what the caller logs, and what makes "the
// retention sweep is running" distinguishable from "the retention sweep is working".

/** One pass's isolation state: the per-table runner plus the names it could not prune. */
export interface RetentionPass {
  /**
   * Prune `table` to `now - windowMs`, treating a non-positive window as disabled. A failure
   * is logged against the table, recorded in {@link failed}, and reported as 0 reclaimed —
   * the pass continues to the next table.
   */
  prune(
    table: string,
    windowMs: number,
    now: number,
    del: (cutoff: number) => Promise<number>,
  ): Promise<number>
  /**
   * The same isolation for a table pruned by its own expiry rather than a window (reset
   * tokens, subscription activations), where there is no window to disable.
   */
  expire(table: string, del: () => Promise<number>): Promise<number>
  /**
   * The same isolation for a table this pass WRITES rather than prunes: today the daily run
   * rollup, which is materialised on the same schedule that bounds its neighbours.
   *
   * It shares the isolation for the reason the prunes do: a failing rollup must not abort the
   * prunes that follow it, and it must be NAMED when it fails rather than reported as "0
   * rows", which is also what a fully caught-up rollup returns. Kept a distinct verb from
   * {@link prune} so a reader of the sweep can see at a glance which tables it is bounding and
   * which it is filling.
   */
  materialize(table: string, write: () => Promise<number>): Promise<number>
  /**
   * The tables whose prune threw this pass, in the order they were attempted. EMPTY on a
   * clean pass — a caller logs it only when non-empty, so a healthy deployment stays quiet.
   */
  readonly failed: string[]
}

/**
 * Start one isolated retention pass. Create a new one per sweep (the {@link RetentionPass.failed}
 * list is per-pass state), then read `failed` after the last table.
 */
export function createRetentionPass(logger?: Logger): RetentionPass {
  const failed: string[] = []
  const isolate = async (table: string, del: () => Promise<number>): Promise<number> => {
    try {
      return await del()
    } catch (error) {
      failed.push(table)
      // WARN, not error: the data is still there and the next pass will retry it, so this is a
      // degradation rather than lost work. It names the table because the whole point of the
      // isolation is that the operator can tell WHICH one is sick.
      logger?.warn('retention: pruning one table failed; continuing the pass', {
        scope: 'retention',
        table,
        ...describeError(error),
      })
      return 0
    }
  }
  return {
    prune: (table, windowMs, now, del) =>
      windowMs <= 0 ? Promise.resolve(0) : isolate(table, () => del(now - windowMs)),
    expire: (table, del) => isolate(table, del),
    materialize: (table, write) => isolate(table, write),
    failed,
  }
}

/**
 * How far back each rollup pass recomputes the daily run buckets.
 *
 * Not just "today": the sweep that owns it runs daily on the Worker and hourly on Node, so a
 * missed pass (a deploy, an isolate that never fired, a restart) would otherwise leave a day
 * permanently half-counted, and a half-counted day is indistinguishable from a quiet one once
 * it is written. Recomputing a short trailing window makes every pass self-healing, at the
 * cost of re-aggregating a few days of runs, which is one indexed GROUP BY, not a scan of
 * history. Shared by both facades so the two cannot drift on how much they heal.
 */
export const RUN_DAY_ROLLUP_LOOKBACK_MS = 3 * 24 * 60 * 60_000

/**
 * One sweep's spend-rollup step, shared by both facades: read the watermark, walk the window,
 * materialise it, and NAME any span the catch-up horizon had to give up on.
 *
 * It is one function rather than four lines repeated per facade because the reporting half is
 * the half that goes missing. Materialising is obvious and both facades would write it; the
 * warning is what turns a permanent hole in the durable record from an invisible event into an
 * operator-visible one, and a hole nobody logs is indistinguishable from a quarter nobody
 * spent anything in, which is the exact failure this whole table exists to prevent.
 *
 * Runs INSIDE {@link RetentionPass.materialize}, so a throw here is isolated and named like
 * any other table's, and the ledger prune that follows it in the sweep still runs.
 */
export async function materializeSpendRollup(
  pass: RetentionPass,
  repository: Pick<SpendRollupRepository, 'rollupSpendDays' | 'spendRollupWatermark'>,
  now: number,
  ledgerRetentionMs: number,
  logger?: Logger,
): Promise<number> {
  return await pass.materialize('spend_days', async () => {
    const watermark = await repository.spendRollupWatermark()
    const { from, to, skipped } = spendRollupWindow(watermark, now, ledgerRetentionMs)
    if (skipped) {
      // WARN rather than error: the pass itself is healthy and everything from `from` on will
      // be recorded. What is lost is bounded and already gone, so this is the one and only
      // notice it gets. `through_day` is a high-water mark and will advance straight over the
      // hole, so nothing downstream can restate it later.
      logger?.warn(
        'retention: the durable spend rollup skipped days it can no longer fold; ' +
          'that attribution is permanently absent',
        {
          scope: 'retention',
          table: 'spend_days',
          skippedFrom: skipped.from,
          skippedTo: skipped.to,
          skippedDays: Math.round((skipped.to - skipped.from) / (24 * 60 * 60_000)),
          watermark,
        },
      )
    }
    return await repository.rollupSpendDays(from, to)
  })
}
