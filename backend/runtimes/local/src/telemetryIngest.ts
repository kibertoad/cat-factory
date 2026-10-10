import { getErrorMessage } from '@cat-factory/kernel'
import type { Clock, Logger } from '@cat-factory/kernel'
import { startSweeper } from '@cat-factory/node-server'
import {
  MAX_TELEMETRY_INGEST_CHARS,
  MachineTokenUnavailableError,
  TELEMETRY_INGEST_LIMITS,
  type MachineTelemetryClient,
  type TelemetryIngestRequest,
  sweepHealth,
} from '@cat-factory/server'
import type { IngestCursor, LocalTelemetryIngestReader } from './sqlite/telemetryIngestReader.js'

// The UPSTREAM half of the mothership-mode telemetry bucket (docs/initiatives/mothership-mode.md,
// PR 5). The capture half writes every LLM call, dispatch context and performed search to the
// laptop's `node:sqlite` store, because putting a network round trip on the hot path of every
// model call is exactly what the local-first bucket exists to avoid. This is the background sweep
// that carries a FINISHED run's rows up to the mothership afterwards, so hosted teammates can read
// the observability of a run a developer drove, and so those rows outlive the node's short local
// retention window.
//
// Two design points worth keeping:
//
//   - "Finished" is QUIESCENCE, not a run-status read. The node holds no execution index of its
//     own (runs live on the mothership), so asking "which runs ended" would mean a remote query
//     per candidate — the N+1 this bucket was created to avoid. A run that has produced no
//     telemetry for the grace period is done as far as its telemetry is concerned, and a RESUMED
//     run simply becomes a candidate again on its next quiet period.
//   - Progress is a per-run high-water mark, advanced only after the whole run drained. A node
//     that dies mid-drain re-offers the rows it already sent, which costs bandwidth and nothing
//     else: the mothership's append is idempotent by row id.

/** How often the sweep runs. Telemetry is read after the fact, so a slow cadence is right. */
const INGEST_SWEEP_INTERVAL_MS = 5 * 60 * 1000

/**
 * How long a run must produce no telemetry before it is uploaded. Long enough that an agent step
 * thinking between model calls is not mistaken for a finished run (which would upload the run
 * repeatedly as it continued), short enough that a developer's teammates see a run's telemetry
 * while it is still the thing being discussed.
 */
const QUIESCENCE_MS = 10 * 60 * 1000

/** Runs uploaded per pass — a bound on how much a single sweep can spend on a backlog. */
const RUNS_PER_SWEEP = 20

/**
 * Rows read per page, per sink. Deliberately the mothership's own per-request ROW caps: a page the
 * node built larger would be refused whole, and the drain would never advance.
 */
const PAGE_SIZES = TELEMETRY_INGEST_LIMITS

/**
 * Headroom left under {@link MAX_TELEMETRY_INGEST_CHARS} for everything in the request body that
 * is not the rows themselves — the envelope's two ids, the sink key, the brackets and separators.
 * Generous, because being a few hundred bytes over the mothership's cap costs a whole refused
 * batch.
 */
const ENVELOPE_OVERHEAD_CHARS = 4_096

/**
 * The byte budget one posted batch may fill. The mothership enforces TWO caps — a row count AND
 * {@link MAX_TELEMETRY_INGEST_CHARS} — and mirroring only the first is what let a page of 20
 * snapshot rows (routinely megabytes each) exceed the byte cap, be refused 413 whole, and leave
 * the run retrying the same doomed page every sweep until the local prune deleted it.
 */
const BATCH_BUDGET_CHARS = MAX_TELEMETRY_INGEST_CHARS - ENVELOPE_OVERHEAD_CHARS

/** A row no batch can ever carry, named so the sweep can REPORT the drop rather than hide it. */
interface OversizedRow {
  id: string
  chars: number
}

/** What one sweep moved, for logging. */
export interface TelemetryIngestSweepResult {
  runs: number
  metrics: number
  snapshots: number
  searchQueries: number
  toolCalls: number
  /** Runs left un-marked because their upload failed — retried on the next pass. */
  failed: number
  /**
   * Rows skipped because one row alone exceeds the mothership's whole-body cap. Reported, never
   * silent: the alternative is a run that can never finish draining, and a cap that drops
   * something has to say so.
   */
  skipped: number
}

export interface TelemetryIngestDeps {
  reader: LocalTelemetryIngestReader
  client: MachineTelemetryClient
  clock: Clock
  log: Logger
}

/** The last row of a page, as the cursor the next page resumes from. */
function cursorOf(rows: { id: string; createdAt: number }[]): IngestCursor | undefined {
  const last = rows[rows.length - 1]
  return last ? { createdAt: last.createdAt, id: last.id } : undefined
}

/** What draining one sink of one run moved, and what it could not move. */
interface SinkDrain {
  uploaded: number
  oversized: OversizedRow[]
}

/**
 * Split one page into batches that each fit {@link BATCH_BUDGET_CHARS}, separating out any row
 * that cannot fit ALONE.
 *
 * The row caps bound COUNT; this bounds BYTES, which is the axis a snapshot row moves — the whole
 * composed prompt plus every injected context file's body. Sizing is by the row's own serialized
 * length, the same measure the mothership applies to the body it receives.
 *
 * A row too big even by itself is returned in `oversized` rather than posted: sending it means a
 * guaranteed 413, which fails the run's whole drain and re-offers the identical page on the next
 * sweep, forever. Skipping it lets the rest of the run through, and the caller reports the drop.
 */
function budgetBatches<Row extends { id: string }>(
  rows: Row[],
): {
  batches: Row[][]
  oversized: OversizedRow[]
} {
  const batches: Row[][] = []
  const oversized: OversizedRow[] = []
  let batch: Row[] = []
  let used = 0
  for (const row of rows) {
    const chars = JSON.stringify(row).length
    if (chars > BATCH_BUDGET_CHARS) {
      oversized.push({ id: row.id, chars })
      continue
    }
    if (batch.length > 0 && used + chars > BATCH_BUDGET_CHARS) {
      batches.push(batch)
      batch = []
      used = 0
    }
    batch.push(row)
    used += chars
  }
  if (batch.length > 0) batches.push(batch)
  return { batches, oversized }
}

/**
 * Drain ONE sink of one run, posting each page as one or more byte-budgeted batches. Pages are
 * read forwards on the `(createdAt, id)` keyset, so a run's telemetry lands on the mothership in
 * the order it was captured — which is what keeps a metric's prompt-delta chain readable there.
 *
 * The cursor advances past a skipped oversized row deliberately: it can never be uploaded, so
 * holding the drain on it would strand every row behind it too. The caller names what was dropped.
 */
async function drainSink<Row extends { id: string; createdAt: number }>(
  read: (cursor: IngestCursor | undefined, limit: number) => Row[],
  limit: number,
  post: (rows: Row[]) => Promise<void>,
): Promise<SinkDrain> {
  let cursor: IngestCursor | undefined
  const drain: SinkDrain = { uploaded: 0, oversized: [] }
  for (;;) {
    const rows = read(cursor, limit)
    if (rows.length === 0) return drain
    const budgeted = budgetBatches(rows)
    for (const batch of budgeted.batches) {
      await post(batch)
      drain.uploaded += batch.length
    }
    drain.oversized.push(...budgeted.oversized)
    cursor = cursorOf(rows)
    // A short page is the last one; asking again would cost a query to learn nothing.
    if (rows.length < limit) return drain
  }
}

/**
 * Upload every quiesced run's telemetry once. Pure over its dependencies (no timer), so it is
 * unit-testable directly — the same shape as `sweepLocalTelemetryRetention`.
 *
 * A run whose upload fails is left UNMARKED and counted in `failed`: the next pass retries it from
 * the beginning, which is safe precisely because the mothership's append is idempotent by row id.
 * One run's failure never stops the pass — a single unreachable moment must not park the backlog.
 */
export async function sweepTelemetryIngest(
  deps: TelemetryIngestDeps,
  now: number,
): Promise<TelemetryIngestSweepResult> {
  const pending = deps.reader.listPendingRuns(now - QUIESCENCE_MS, RUNS_PER_SWEEP)
  const result: TelemetryIngestSweepResult = {
    runs: 0,
    metrics: 0,
    snapshots: 0,
    searchQueries: 0,
    toolCalls: 0,
    failed: 0,
    skipped: 0,
  }
  for (const run of pending) {
    const { workspaceId, executionId } = run
    const send = (batch: Omit<TelemetryIngestRequest, 'workspaceId' | 'executionId'>) =>
      deps.client.ingest({ workspaceId, executionId, ...batch }).then(() => undefined)
    try {
      const metrics = await drainSink(
        (cursor, limit) => deps.reader.listMetrics(workspaceId, executionId, cursor, limit),
        PAGE_SIZES.metrics,
        (rows) => send({ metrics: rows }),
      )
      const snapshots = await drainSink(
        (cursor, limit) => deps.reader.listSnapshots(workspaceId, executionId, cursor, limit),
        PAGE_SIZES.snapshots,
        (rows) => send({ snapshots: rows }),
      )
      const searchQueries = await drainSink(
        (cursor, limit) => deps.reader.listSearchQueries(workspaceId, executionId, cursor, limit),
        PAGE_SIZES.searchQueries,
        (rows) => send({ searchQueries: rows }),
      )
      const toolCalls = await drainSink(
        (cursor, limit) => deps.reader.listToolCalls(workspaceId, executionId, cursor, limit),
        PAGE_SIZES.toolCalls,
        (rows) => send({ toolCalls: rows }),
      )
      result.metrics += metrics.uploaded
      result.snapshots += snapshots.uploaded
      result.searchQueries += searchQueries.uploaded
      result.toolCalls += toolCalls.uploaded
      // A row too large to ever post is dropped rather than retried forever — but a cap that drops
      // something says what it dropped, naming the rows so the gap in the mothership's view of
      // this run is explicable rather than an unexplained hole.
      const oversized = [
        ...metrics.oversized,
        ...snapshots.oversized,
        ...searchQueries.oversized,
        ...toolCalls.oversized,
      ]
      if (oversized.length > 0) {
        result.skipped += oversized.length
        deps.log.warn('mothership telemetry ingest skipped rows over the body cap', {
          workspaceId,
          executionId,
          skipped: oversized.length,
          capChars: BATCH_BUDGET_CHARS,
          rows: oversized.map((row) => `${row.id}:${row.chars}`).join(','),
        })
      }
      // Marked only once every sink drained — the mark is what stops the run being re-offered, so
      // writing it after a partial upload would strand whatever had not been sent yet.
      deps.reader.markIngested(workspaceId, executionId, run.lastWriteAt, now)
      result.runs += 1
    } catch (error) {
      result.failed += 1
      // No token yet: EVERY remaining run would fail the same way, so the pass stops here with one
      // line instead of twenty identical ones. The runs stay candidates — nothing was marked.
      if (error instanceof MachineTokenUnavailableError) {
        deps.log.info('mothership telemetry ingest deferred: node has not logged in yet', {
          pending: pending.length,
        })
        return result
      }
      deps.log.warn('mothership telemetry ingest failed for a run', {
        workspaceId,
        executionId,
        err: getErrorMessage(error),
      })
    }
  }
  return result
}

/**
 * Start the periodic telemetry ingest sweep. Best-effort throughout — losing observability must
 * never take the node down, and an unreachable mothership only means the rows stay local until it
 * comes back.
 *
 * Like the retention sweep, the returned stop function is ASYNC and must be AWAITED before the
 * telemetry store is closed: a pass in flight when shutdown closes the SQLite handle would die on
 * "database is not open" and put a spurious error line on every clean exit.
 */
export function startTelemetryIngest(deps: TelemetryIngestDeps): () => Promise<void> {
  let stopped = false
  let inFlight: Promise<unknown> | undefined
  const stopSweeper = startSweeper({
    name: 'mothership-telemetry-ingest',
    intervalMs: INGEST_SWEEP_INTERVAL_MS,
    log: deps.log,
    health: sweepHealth,
    failureMessage: 'mothership telemetry ingest sweep failed',
    tick: async () => {
      if (stopped) return
      const pass = sweepTelemetryIngest(deps, deps.clock.now())
      inFlight = pass
      try {
        const moved = await pass
        if (moved.runs > 0 || moved.failed > 0 || moved.skipped > 0) {
          deps.log.info('mothership telemetry ingest uploaded runs', { ...moved })
        }
      } finally {
        if (inFlight === pass) inFlight = undefined
      }
    },
  })
  return async () => {
    stopped = true
    stopSweeper()
    // silent-catch-ok: the sweeper's own error handler already logged this pass's failure; here we
    // only need it to have FINISHED touching the store before the caller closes it.
    await inFlight?.catch(() => undefined)
  }
}
