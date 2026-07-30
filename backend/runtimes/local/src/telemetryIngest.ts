import type { Clock, Logger } from '@cat-factory/kernel'
import { startSweeper } from '@cat-factory/node-server'
import {
  TELEMETRY_INGEST_LIMITS,
  type MachineTelemetryClient,
  type TelemetryIngestRequest,
} from '@cat-factory/server'
import type { IngestCursor, LocalTelemetryIngestReader } from './sqlite/telemetryStore.js'

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
 * Rows read (and posted) per request, per sink. Deliberately the mothership's own per-request
 * caps: a page the node built larger would be refused whole, and the drain would never advance.
 */
const PAGE_SIZES = TELEMETRY_INGEST_LIMITS

/** What one sweep moved, for logging. */
export interface TelemetryIngestSweepResult {
  runs: number
  metrics: number
  snapshots: number
  searchQueries: number
  /** Runs left un-marked because their upload failed — retried on the next pass. */
  failed: number
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

/**
 * Drain ONE sink of one run, posting each page as its own batch. Returns how many rows were
 * uploaded. Pages are read forwards on the `(createdAt, id)` keyset, so a run's telemetry lands on
 * the mothership in the order it was captured — which is what keeps a metric's prompt-delta chain
 * readable there.
 */
async function drainSink<Row extends { id: string; createdAt: number }>(
  read: (cursor: IngestCursor | undefined, limit: number) => Row[],
  limit: number,
  post: (rows: Row[]) => Promise<void>,
): Promise<number> {
  let cursor: IngestCursor | undefined
  let uploaded = 0
  for (;;) {
    const rows = read(cursor, limit)
    if (rows.length === 0) return uploaded
    await post(rows)
    uploaded += rows.length
    cursor = cursorOf(rows)
    // A short page is the last one; asking again would cost a query to learn nothing.
    if (rows.length < limit) return uploaded
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
    failed: 0,
  }
  for (const run of pending) {
    const { workspaceId, executionId } = run
    const send = (batch: Omit<TelemetryIngestRequest, 'workspaceId' | 'executionId'>) =>
      deps.client.ingest({ workspaceId, executionId, ...batch }).then(() => undefined)
    try {
      result.metrics += await drainSink(
        (cursor, limit) => deps.reader.listMetrics(workspaceId, executionId, cursor, limit),
        PAGE_SIZES.metrics,
        (metrics) => send({ metrics }),
      )
      result.snapshots += await drainSink(
        (cursor, limit) => deps.reader.listSnapshots(workspaceId, executionId, cursor, limit),
        PAGE_SIZES.snapshots,
        (snapshots) => send({ snapshots }),
      )
      result.searchQueries += await drainSink(
        (cursor, limit) => deps.reader.listSearchQueries(workspaceId, executionId, cursor, limit),
        PAGE_SIZES.searchQueries,
        (searchQueries) => send({ searchQueries }),
      )
      // Marked only once every sink drained — the mark is what stops the run being re-offered, so
      // writing it after a partial upload would strand whatever had not been sent yet.
      deps.reader.markIngested(workspaceId, executionId, run.lastWriteAt, now)
      result.runs += 1
    } catch (error) {
      result.failed += 1
      deps.log.warn('mothership telemetry ingest failed for a run', {
        workspaceId,
        executionId,
        err: error instanceof Error ? error.message : String(error),
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
    failureMessage: 'mothership telemetry ingest sweep failed',
    tick: async () => {
      if (stopped) return
      const pass = sweepTelemetryIngest(deps, deps.clock.now())
      inFlight = pass
      try {
        const moved = await pass
        if (moved.runs > 0 || moved.failed > 0) {
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
