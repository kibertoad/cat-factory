import { type Logger, describeError } from '@cat-factory/kernel'

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
