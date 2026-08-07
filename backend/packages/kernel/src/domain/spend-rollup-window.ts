// How much of the ledger one durable-spend-rollup fold covers, in the two places a fold
// happens: the retention sweep's periodic pass over every board, and the FINAL pass a board
// takes on its way out of existence.
//
// Pure, and in kernel rather than beside the sweep, because those two callers sit in different
// layers (`@cat-factory/orchestration`'s retention pass and `@cat-factory/workspaces`'
// `WorkspaceService.delete`) and must agree about one thing in particular: the catch-up horizon
// is the LEDGER's retention. Restating that rule per caller is how the delete path would end up
// stepping over days the sweep would still have folded.

/**
 * How far back a steady-state spend-rollup pass recomputes.
 *
 * Not just "today": the sweep that owns it runs daily on the Worker and hourly on Node, so a
 * missed pass (a deploy, an isolate that never fired, a restart) would otherwise leave a day
 * permanently half-counted, and a half-counted day is indistinguishable from a quiet one once
 * it is written. Recomputing a short trailing window makes every pass self-healing, at the cost
 * of re-aggregating a few days of runs, which is one indexed GROUP BY, not a scan of history.
 */
export const SPEND_DAY_ROLLUP_LOOKBACK_MS = 3 * 24 * 60 * 60_000

/**
 * The most a SINGLE fold will aggregate. The catch-up walk below can ask for an arbitrarily
 * wide window (a deployment that has never rolled up, a sweep down for a week), and one
 * unbounded `GROUP BY` over a busy deployment's whole ledger is how a cron pass turns into a
 * row-limit error on D1 or a long-running query on Postgres, which would then fail on every
 * subsequent pass too, since the window only widens.
 */
export const SPEND_DAY_ROLLUP_MAX_SPAN_MS = 30 * 24 * 60 * 60_000

/**
 * How far back the FIRST pass on a deployment reaches. The rollup serves the 90-day report
 * window, so a rollup that started at "today" would under-report that window for a quarter
 * while looking complete: the ledger holds the data, and the reader has no way to see that the
 * newer store simply had not been asked yet. Older history than this is deliberately not
 * backfilled: `rolledUpThrough` states where the durable record begins.
 *
 * It also serves as the FLOOR under a resumed pass when the ledger has no retention window of
 * its own to derive one from. See {@link spendRollupWindow}.
 */
export const SPEND_DAY_ROLLUP_BACKFILL_MS = 90 * 24 * 60 * 60_000

/**
 * How long a board's FINAL fold may keep its delete waiting, checked between chunks.
 *
 * The sweep folds on a cron, where taking longer costs only the cron; the final fold runs inside
 * a user's delete request, where it costs the request. And the walk it bounds is unbounded by
 * construction: {@link finalSpendFoldPlan} covers everything back to the resume point, which a
 * watermark left stale by an outage puts a ledger-retention (395 days by default) behind now, so
 * fourteen sequential aggregates is a reachable plan rather than a pathological one. On the
 * Worker, where the whole delete is one invocation, that is how the fold stops being the thing
 * that preserves a board's spend and becomes the thing that prevents its deletion: the request
 * dies before the cascade, and the retry re-reads the same watermark and plans the same walk.
 *
 * So the walk is a budget rather than a promise. What it does not reach is REPORTED as lost,
 * which is the same disposition the rest of this path already takes: the delete wins, and the
 * loss is named. Checked BETWEEN chunks, so it bounds how MANY aggregates run, not how long one
 * of them takes; {@link SPEND_DAY_ROLLUP_MAX_SPAN_MS} is what bounds the one.
 */
export const FINAL_SPEND_FOLD_BUDGET_MS = 10_000

/** A half-open `[from, to)` span of wall-clock time, in epoch ms. */
export interface SpendFoldSpan {
  from: number
  to: number
}

/** One spend-rollup pass's window, plus whatever it had to give up on to produce it. */
export interface SpendRollupWindow extends SpendFoldSpan {
  /**
   * The span the catch-up horizon dropped, or null when the walk covers everything the last
   * pass left. NON-NULL IS A PERMANENT DATA GAP, not a deferral: nothing re-offers these days
   * to a later pass, and the watermark advances past them. Whoever calls this must SAY so:
   * `through_day` is a high-water mark and cannot represent a hole, so the log line is the
   * only place the hole is ever named.
   */
  skipped: SpendFoldSpan | null
}

/**
 * Where a fold has to START, given what the last pass covered and how long the LEDGER it folds
 * is retained, plus whatever the horizon put out of reach.
 *
 * The resume point is the sweep's own watermark, not a fixed lookback, because a gap in this
 * rollup is permanent: nothing else retains the attribution it is folding, so a day the sweep
 * skipped while it was down is a day whose TCO history is simply missing, forever. Resuming
 * from the watermark turns "the sweep was down for a week" into a few catch-up passes instead.
 *
 * Which is why the catch-up horizon is derived from `ledgerRetentionMs` rather than reusing the
 * backfill constant. The two answer different questions and only look alike. The backfill bounds
 * a FIRST pass, where the choice is how much history to adopt and 90 days is a judgement call. A
 * resumed pass has no such choice: every day between the watermark and now is a day this
 * deployment has already committed to recording, and the ledger still HOLDS it (the prune runs
 * in the same sweep, so a sweep that was down pruned nothing either). A horizon shorter than the
 * ledger's own retention would step over those days while they were still readable, which is
 * losing data that was there for the asking. Past the ledger's retention there is genuinely
 * nothing left to fold, so that is where the walk stops, and the pathological watermark the
 * horizon exists to contain (hand-edited, restored from a backup, epoch-zero) is still contained.
 *
 * @param ledgerRetentionMs how long `token_usage` is kept; 0 or less means the ledger is never
 *   pruned, in which case there is no retention edge to derive a horizon from and the backfill
 *   constant is the floor.
 */
function foldStart(
  throughDay: number | null,
  now: number,
  ledgerRetentionMs: number,
): { from: number; skipped: SpendFoldSpan | null } {
  // A `null` watermark is "no pass has ever completed", not "start from now": see the backfill
  // constant. Once there IS one, the steady-state lookback still applies on top of it, so a day
  // that was still accruing when it was covered gets recomputed rather than frozen half-counted.
  const resume =
    throughDay == null
      ? now - SPEND_DAY_ROLLUP_BACKFILL_MS
      : Math.min(throughDay, now - SPEND_DAY_ROLLUP_LOOKBACK_MS)
  const horizon = now - Math.max(ledgerRetentionMs, SPEND_DAY_ROLLUP_BACKFILL_MS)
  return {
    from: Math.max(resume, horizon),
    skipped: throughDay != null && resume < horizon ? { from: resume, to: horizon } : null,
  }
}

/**
 * The window ONE spend-rollup sweep pass should materialise. Bounded by
 * {@link SPEND_DAY_ROLLUP_MAX_SPAN_MS} because the sweep gets another turn: a wide catch-up
 * becomes several passes rather than one unbounded `GROUP BY`.
 *
 * Pure so both facades share it (and so the walk is unit-testable without a database): the
 * caller reads the watermark, calls this, materialises `[from, to)`, and reports `skipped`.
 */
export function spendRollupWindow(
  throughDay: number | null,
  now: number,
  ledgerRetentionMs: number,
): SpendRollupWindow {
  const { from, skipped } = foldStart(throughDay, now, ledgerRetentionMs)
  return { from, to: Math.min(now, from + SPEND_DAY_ROLLUP_MAX_SPAN_MS), skipped }
}

/** The spans a board's FINAL fold has to cover, plus the span no fold can reach any more. */
export interface FinalSpendFoldPlan {
  /**
   * NEWEST FIRST, each at most {@link SPEND_DAY_ROLLUP_MAX_SPAN_MS} wide, together covering
   * everything from the resume point up to `now` with no seam between them.
   *
   * The order is a PRIORITY, not a presentation choice, and it is the reason the walk may be cut
   * short at all. A fold that runs out of {@link FINAL_SPEND_FOLD_BUDGET_MS} (or hits a sick
   * store) keeps whichever chunks it got to, and the chunks worth keeping are the recent ones:
   * every report window this rollup serves is anchored at `now`, so the days adjacent to the
   * delete are read by all of them, while the far end of a stale-watermark catch-up is outside
   * even the 90-day window. Oldest-first inverts exactly that, and does it invisibly: the walk
   * looks complete right up until the newest days, the ones the whole final fold exists for, are
   * the ones that never ran.
   */
  spans: SpendFoldSpan[]
  /** As {@link SpendRollupWindow.skipped}: days the ledger no longer holds. */
  skipped: SpendFoldSpan | null
}

/**
 * The plan for the LAST fold a board ever gets, run inside its own deletion.
 *
 * Same resume point and same horizon as {@link spendRollupWindow}, and a different bound on the
 * far end: the sweep can leave a wide catch-up for its next pass, and a board being deleted has
 * no next pass. Its ledger rows go with the cascade, so whatever this plan does not cover is
 * gone rather than deferred. So the span cap becomes a CHUNK size instead of a truncation, and
 * the walk runs to `now`: the cap exists to keep one `GROUP BY` bounded, which several
 * sequential queries satisfy just as well.
 *
 * `skipped` is the loss that predates the delete: those days are past the ledger's own retention,
 * so there is nothing left anywhere to fold. The walk's own budget can produce a second one, and
 * that is why {@link FinalSpendFoldPlan.spans} is ordered newest first.
 */
export function finalSpendFoldPlan(
  throughDay: number | null,
  now: number,
  ledgerRetentionMs: number,
): FinalSpendFoldPlan {
  const { from, skipped } = foldStart(throughDay, now, ledgerRetentionMs)
  const spans: SpendFoldSpan[] = []
  // Walked backwards from `now` so the FIRST chunk is the one ending at the delete, whatever the
  // resume point is. Chunking forwards and reversing would instead align the ragged remainder
  // with `now`, making the most valuable chunk the narrowest one.
  for (let to = now; to > from; to -= SPEND_DAY_ROLLUP_MAX_SPAN_MS) {
    spans.push({ from: Math.max(from, to - SPEND_DAY_ROLLUP_MAX_SPAN_MS), to })
  }
  return { spans, skipped }
}
