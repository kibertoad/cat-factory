import { type Logger, type SpendRollupRepository, describeError } from '@cat-factory/kernel'

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

/** How far back a steady-state spend-rollup pass recomputes, for the reason above. */
export const SPEND_DAY_ROLLUP_LOOKBACK_MS = 3 * 24 * 60 * 60_000

/**
 * The most a SINGLE spend-rollup pass will aggregate. The catch-up walk below can ask for an
 * arbitrarily wide window (a deployment that has never rolled up, a sweep down for a week),
 * and one unbounded `GROUP BY` over a busy deployment's whole ledger is how a cron pass turns
 * into a row-limit error on D1 or a long-running query on Postgres, which would then fail on
 * every subsequent pass too, since the window only widens.
 */
export const SPEND_DAY_ROLLUP_MAX_SPAN_MS = 30 * 24 * 60 * 60_000

/**
 * How far back the FIRST pass on a deployment reaches. The rollup serves the 90-day report
 * window, so a rollup that started at "today" would under-report that window for a quarter
 * while looking complete: the ledger holds the data, and the reader has no way to see that
 * the newer store simply had not been asked yet. Older history than this is deliberately not
 * backfilled: `rolledUpThrough` states where the durable record begins.
 *
 * It also serves as the FLOOR under a resumed pass when the ledger has no retention window of
 * its own to derive one from. See {@link spendRollupWindow}.
 */
export const SPEND_DAY_ROLLUP_BACKFILL_MS = 90 * 24 * 60 * 60_000

/** One spend-rollup pass's window, plus whatever it had to give up on to produce it. */
export interface SpendRollupWindow {
  from: number
  to: number
  /**
   * The span the catch-up horizon dropped, or null when the walk covers everything the last
   * pass left. NON-NULL IS A PERMANENT DATA GAP, not a deferral: nothing re-offers these days
   * to a later pass, and the watermark advances past them. Whoever calls this must SAY so:
   * `through_day` is a high-water mark and cannot represent a hole, so the log line is the
   * only place the hole is ever named.
   */
  skipped: { from: number; to: number } | null
}

/**
 * The window one spend-rollup pass should materialise, given what the last pass covered and
 * how long the LEDGER it folds is retained.
 *
 * Unlike the run rollup, which recomputes a fixed trailing lookback, this one walks FORWARD
 * from the sweep's own watermark. The difference is that a gap here is permanent: nothing
 * else retains the attribution the rollup is folding, so a day the sweep skipped while it was
 * down is a day whose TCO history is simply missing, forever. Resuming from the watermark
 * turns "the sweep was down for a week" into a few catch-up passes instead.
 *
 * Which is why the catch-up horizon is derived from `ledgerRetentionMs` rather than reusing
 * the backfill constant. The two answer different questions and only look alike. The backfill
 * bounds a FIRST pass, where the choice is how much history to adopt and 90 days is a
 * judgement call. A resumed pass has no such choice: every day between the watermark and now
 * is a day this deployment has already committed to recording, and the ledger still HOLDS it
 * (the prune runs in this same sweep, so a sweep that was down pruned nothing either). A
 * horizon shorter than the ledger's own retention would step over those days while they were
 * still readable, which is losing data that was there for the asking. Past the ledger's
 * retention there is genuinely nothing left to fold, so that is where the walk stops, and the
 * pathological watermark the horizon exists to contain (hand-edited, restored from a backup,
 * epoch-zero) is still contained.
 *
 * Pure so both facades share it (and so the walk is unit-testable without a database): the
 * caller reads the watermark, calls this, materialises `[from, to)`, and reports `skipped`.
 *
 * @param ledgerRetentionMs how long `token_usage` is kept; 0 or less means the ledger is
 *   never pruned, in which case there is no retention edge to derive a horizon from and the
 *   backfill constant is the floor.
 */
export function spendRollupWindow(
  throughDay: number | null,
  now: number,
  ledgerRetentionMs: number,
): SpendRollupWindow {
  // A `null` watermark is "no pass has ever completed", not "start from now": see the
  // backfill constant. Once there IS one, the steady-state lookback still applies on top of
  // it, so a day that was still accruing when it was covered gets recomputed rather than
  // frozen half-counted.
  const resume =
    throughDay == null
      ? now - SPEND_DAY_ROLLUP_BACKFILL_MS
      : Math.min(throughDay, now - SPEND_DAY_ROLLUP_LOOKBACK_MS)
  const horizon = now - Math.max(ledgerRetentionMs, SPEND_DAY_ROLLUP_BACKFILL_MS)
  // Never walk back past the horizon, and never aggregate more than one pass's worth in one
  // query. A first pass is bounded by its own backfill choice, so only a RESUMED one can be
  // cut here, and only that one has days it was already committed to.
  const from = Math.max(resume, horizon)
  return {
    from,
    to: Math.min(now, from + SPEND_DAY_ROLLUP_MAX_SPAN_MS),
    skipped: throughDay != null && resume < horizon ? { from: resume, to: horizon } : null,
  }
}

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
