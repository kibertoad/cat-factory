import type {
  AgentContextIndexQuery,
  AgentContextRunPageQuery,
  AgentContextSnapshot,
  AgentContextSnapshotIndex,
  AgentContextSnapshotRepository,
  AgentSearchQuery,
  AgentSearchQueryPageQuery,
  AgentSearchQueryRepository,
  LlmCallBodyWindow,
  LlmCallMetric,
  LlmCallMetricPage,
  LlmCallMetricRepository,
  LlmCallMetricSummary,
  LlmCallPageQuery,
  LlmCallRunPageQuery,
  Logger,
} from '@cat-factory/kernel'
import { noopLogger } from '@cat-factory/kernel'
import {
  TELEMETRY_READ_PAGE_SIZES,
  TelemetryReadTooLargeError,
  telemetryReadBodyCap,
  type MachineTelemetryReadClient,
  type TelemetryReadRepository,
} from '@cat-factory/server'
import type { LocalTelemetryCoverage } from './sqlite/telemetryCoverage.js'

// The mothership-mode telemetry READ-THROUGH, on the LOCAL side (docs/initiatives/mothership-mode.md,
// PR 5 — the last piece of the telemetry bucket).
//
// Telemetry is captured on the laptop and pruned there on a short window; a quiesced run's rows
// are carried up to the mothership by the ingest sweep. Both halves are about the WRITE
// direction, and what they leave is a node that renders three kinds of run wrong:
//
//   - one somebody ELSE drove, whose rows were never local at all — the common case, because a
//     mothership-mode SPA shows the whole org's board,
//   - one this node drove whose local rows have since been pruned ENTIRELY, and
//   - one whose local rows were pruned in PART, which is the subtle one: the store answers, so
//     nothing looks missing, but it answers with a suffix.
//
// None of the three reports a problem. The first two render an empty observability panel, a zero
// rollup and an absent search log — exactly what a run that spent nothing looks like. The third
// renders a SHORT list and an understated token total, which is worse, because a number carries no
// hint that it is short. This decorator closes all three by asking the mothership when — and only
// when — the LOCAL store is not the whole truth for the run.
//
// Four properties are load-bearing.
//
// **Local wins where it is WHOLE.** Not merely where it is non-empty: the prune deletes by
// `created_at`, so a run straddling the cutoff keeps its newer rows and loses its older ones, and
// an emptiness test reads that subset as the run. `telemetryCoverage.ts` records the runs the
// prune has taken from, and that record — not the presence of rows — is what makes a local answer
// authoritative. Where local IS whole (a run this node is driving, the overwhelmingly common
// case) nothing goes over the network: the local store is both fresher, holding the run in flight
// before any ingest, and cheaper.
//
// **A failed fallback THROWS; it never degrades to the empty answer it was called to replace.**
// The whole defect being fixed is that "no rows here" and "no rows anywhere" render identically,
// so a swallowed failure would reinstate it with an extra step. The one caller on a hot path
// (`RunStateMachine.attachStepMetrics`, which rolls a run's spend onto the emitted steps) already
// treats a metrics read as best-effort and swallows, so a mothership outage costs a board counter
// rather than the run — and the aggregate reads carry a SHORT round-trip budget (declared on
// `TELEMETRY_READ_METHODS`) precisely because that caller awaits them on the emit path.
//
// **It composes with keyset paging rather than fighting it.** A run whose oldest rows were pruned
// stitches back together across the two stores: local answers with the suffix it still holds, and
// the mothership answers for everything strictly older, on the SAME `(createdAt, id)` cursor —
// exact, because the ingest preserves each row's id and `createdAt`. The stitch rests on the prune
// removing a PREFIX (`deleteOlderThan`, the only path that deletes), so what local retains is
// always a suffix; a future local delete that took rows from the middle would break it, and would
// have to be reflected here.
//
// **An over-large page is a routine condition, not a failure.** A page within its row cap can
// still serialize past the mothership's byte backstop — three whole snapshots at the capture
// ceiling are ~12 MiB — so the drain halves its page and re-asks on the same cursor. Retrying is
// not a clamp in disguise: the cursor only advances over rows actually received, so a narrower
// page loses nothing. Only the drain does this; a page a CALLER sized propagates the refusal
// instead, because silently returning fewer rows than asked is read as the end of the run.

/** The three run-scoped telemetry repositories this decorates. */
export interface ReadThroughTelemetryRepositories {
  llmCallMetricRepository: LlmCallMetricRepository
  agentContextSnapshotRepository: AgentContextSnapshotRepository
  agentSearchQueryRepository: AgentSearchQueryRepository
}

/** What the read-through needs besides the local store it decorates. */
export interface TelemetryReadThroughDeps {
  /** Performs one bounded read against the mothership. */
  client: MachineTelemetryReadClient
  /**
   * Whether the local store still holds ALL of a run's rows. Required rather than optional: a
   * default of "always complete" would silently restore the partial-run under-reporting this
   * exists to remove, and it would do so on the surface — a token total — least likely to be
   * questioned.
   */
  coverage: LocalTelemetryCoverage
  logger?: Logger
}

/**
 * Ceiling on how many rows a `listByExecution` fallback will drain from the mothership when the
 * caller named no limit of its own.
 *
 * `listByExecution` has no cursor, so the node has to decide where to stop; these are the caps a
 * local answer would effectively have been bounded by anyway (a run's own capture volume). A
 * drain that REACHES its cap is logged with the run it stopped on, because a silently shortened
 * list would read to whoever is looking at the panel as the whole run.
 */
const DRAIN_CAPS = {
  metrics: 1000,
  snapshots: 200,
  searchQueries: 2000,
} as const

/**
 * Wrap `local` so that a read the local store cannot answer WHOLE is answered from the mothership.
 *
 * Only READS are decorated. `record` / `recordMany` / `latestChainTip` / `deleteOlderThan` pass
 * straight through to the local store: the first three are the capture hot path (the whole reason
 * this bucket is local-first), the chain tip must resolve against the rows this node actually
 * holds or it would compute a prompt delta against a tip it cannot reproduce, and the prune owns
 * local rows only.
 */
export function withTelemetryReadThrough(
  local: ReadThroughTelemetryRepositories,
  deps: TelemetryReadThroughDeps,
): ReadThroughTelemetryRepositories {
  const log = (deps.logger ?? noopLogger).child({ scope: 'telemetryReadThrough' })
  const read = <T>(
    repo: TelemetryReadRepository,
    method: string,
    workspaceId: string,
    args: unknown[],
  ): Promise<T> => deps.client.read({ workspaceId, repo, method, args }) as Promise<T>
  const ctx: ReadThroughContext = {
    read,
    log,
    // A run local has rows for is authoritative only while the prune has taken none of them.
    whole: (workspaceId, executionId, held) =>
      held > 0 && deps.coverage.isRunLocallyComplete(workspaceId, executionId),
  }

  return {
    llmCallMetricRepository: metricsReadThrough(local.llmCallMetricRepository, ctx),
    agentContextSnapshotRepository: snapshotsReadThrough(local.agentContextSnapshotRepository, ctx),
    agentSearchQueryRepository: searchQueriesReadThrough(local.agentSearchQueryRepository, ctx),
  }
}

/** Perform one bounded read against the mothership, with the workspace as the bound scope. */
type RemoteRead = <T>(
  repo: TelemetryReadRepository,
  method: string,
  workspaceId: string,
  args: unknown[],
) => Promise<T>

/** What each sink's decorator needs from the wrapper. */
interface ReadThroughContext {
  read: RemoteRead
  log: Logger
  /** Whether a local answer holding `held` rows for this run is the WHOLE of it. */
  whole: (workspaceId: string, executionId: string, held: number) => boolean
}

/** A row of any of the three sinks, reduced to what the shared keyset drain needs. */
interface KeysetRow {
  id: string
  createdAt: number
}

/** The EXCLUSIVE cursor that continues after `rows`' oldest entry, or undefined when it is empty. */
function cursorAfter(rows: readonly KeysetRow[]): KeysetRow | undefined {
  const last = rows[rows.length - 1]
  return last ? { createdAt: last.createdAt, id: last.id } : undefined
}

/**
 * Whether a page-shaped local answer can be returned as-is.
 *
 * A FULL page is always its own answer — the caller holds a cursor and will come back for more,
 * and a run that is missing older rows reaches the seam on a later page, where this same test
 * fails and the fallback picks it up. A SHORT page is the end of the data only if the local store
 * is whole for the run; otherwise the missing rows are exactly what makes it short.
 */
function pageIsAnswerable(
  ctx: ReadThroughContext,
  workspaceId: string,
  executionId: string,
  held: number,
  limit: number,
): boolean {
  return held >= limit || ctx.whole(workspaceId, executionId, held)
}

/**
 * Page a remote read forwards from newest to oldest until it is exhausted or `cap` rows have been
 * collected, cursoring on the `(createdAt, id)` composite every telemetry read orders by.
 *
 * Reaching the cap is REPORTED rather than silently returned as a complete list: the caller is
 * rendering a run, and a list that quietly stops partway reads as the whole of it.
 *
 * A page refused for SIZE halves and re-asks on the same cursor. That terminates: the mothership's
 * backstop is derived to exceed the largest single row either body-bearing sink can store, so a
 * one-row page can never be refused for size (`MAX_TELEMETRY_READ_CHARS`, pinned by an assertion
 * against both capture ceilings).
 */
async function drainPages<T extends KeysetRow>(
  opts: {
    pageSize: number
    cap: number
    cursor?: KeysetRow
    log: Logger
    what: string
    executionId: string
  },
  fetchPage: (cursor: KeysetRow | undefined, limit: number) => Promise<T[]>,
): Promise<T[]> {
  const rows: T[] = []
  // The local store already filled the caller's whole allowance, so there is no remainder to
  // fetch. Returning HERE rather than falling through the loop matters: with no iterations left
  // the tail below would report a cap it never reached, and a "capped a run's calls" warning about
  // a complete answer is exactly the kind of noise that teaches a reader to ignore the real one.
  if (opts.cap <= 0) return rows
  let cursor = opts.cursor
  let pageSize = opts.pageSize
  while (rows.length < opts.cap) {
    // Never ask for more than the cap still allows, so the last page is not over-fetched.
    const want = Math.min(pageSize, opts.cap - rows.length)
    let page: T[]
    try {
      page = await fetchPage(cursor, want)
    } catch (error) {
      // Within its ROW cap but over the mothership's BYTE backstop — a run with large prompts, not
      // a fault. Re-ask smaller on the same cursor; nothing is lost because the cursor has not
      // moved. Any other failure propagates, as does this one at a page of 1 (unreachable by the
      // backstop's derivation, so reaching it means that invariant broke and must be reported).
      if (error instanceof TelemetryReadTooLargeError && want > 1) {
        pageSize = Math.max(1, Math.floor(want / 2))
        opts.log.debug('read-through narrowed a page the mothership refused for size', {
          executionId: opts.executionId,
          what: opts.what,
          was: want,
          now: pageSize,
        })
        continue
      }
      throw error
    }
    rows.push(...page)
    // A SHORT page means the store had no more, and terminating on it is what makes the drain
    // finite. A full one may or may not — finding out costs another request, which is exactly
    // what the next iteration is.
    if (page.length < want) return rows
    const next = cursorAfter(page)
    if (!next) return rows
    cursor = next
  }
  // Stopped ON the cap rather than on an exhausted store. It is possible the run held exactly
  // this many rows and nothing was actually dropped — distinguishing the two would cost one more
  // request per drain, and reporting a cap that happened to be exact is the cheaper error.
  opts.log.warn(`read-through capped a run's ${opts.what}`, {
    executionId: opts.executionId,
    cap: opts.cap,
    collected: rows.length,
  })
  return rows
}

function metricsReadThrough(
  local: LlmCallMetricRepository,
  ctx: ReadThroughContext,
): LlmCallMetricRepository {
  return {
    // Capture + prune + chain-tip: local only. See the module note.
    record: (metric) => local.record(metric),
    recordMany: (metrics) => local.recordMany(metrics),
    latestChainTip: (ws, ex, kind) => local.latestChainTip(ws, ex, kind),
    deleteOlderThan: (epochMs) => local.deleteOlderThan(epochMs),

    async listByExecution(ws, executionId, limit, agentKind) {
      const rows = await local.listByExecution(ws, executionId, limit, agentKind)
      if (ctx.whole(ws, executionId, rows.length)) return rows
      const cap = limit ?? DRAIN_CAPS.metrics
      // Everything strictly OLDER than local's oldest row — the disjoint remainder, per the
      // module note's prefix-prune invariant. With no local rows this is the whole run.
      const older = await drainPages<LlmCallMetric>(
        {
          pageSize: TELEMETRY_READ_PAGE_SIZES.metrics,
          cap: cap - rows.length,
          cursor: cursorAfter(rows),
          log: ctx.log,
          what: 'calls',
          executionId,
        },
        (cursor, pageLimit) =>
          ctx.read<LlmCallMetric[]>('llmCallMetricRepository', 'listRunPage', ws, [
            { executionId, agentKind, limit: pageLimit, cursor } satisfies LlmCallRunPageQuery,
          ]),
      )
      return [...rows, ...older]
    },

    async listRunPage(ws, query: LlmCallRunPageQuery) {
      const rows = await local.listRunPage(ws, query)
      if (pageIsAnswerable(ctx, ws, query.executionId, rows.length, query.limit)) return rows
      return ctx.read<LlmCallMetric[]>('llmCallMetricRepository', 'listRunPage', ws, [query])
    },

    async listPage(ws, query: LlmCallPageQuery) {
      const rows = await local.listPage(ws, query)
      if (pageIsAnswerable(ctx, ws, query.executionId, rows.length, query.limit)) return rows
      // The whole page from the mothership rather than a stitch: this read's ORDER and cursor are
      // the caller's, so where the seam falls depends on which direction it is walking, and
      // re-deriving that across two stores per page is where the off-by-one lives. The mothership
      // holds the run's complete copy, so one read answers it in any order.
      return ctx.read<LlmCallMetricPage[]>('llmCallMetricRepository', 'listPage', ws, [query])
    },

    async get(ws, id, body?: LlmCallBodyWindow) {
      const row = await local.get(ws, id, body)
      if (row) return row
      return ctx.read<LlmCallMetricPage | null>('llmCallMetricRepository', 'get', ws, [
        id,
        withDeclaredBodyCap('llmCallMetricRepository', 'get', body),
      ])
    },

    async summarizeByExecution(ws, executionId) {
      const cells = await local.summarizeByExecution(ws, executionId)
      // Cell COUNT stands in for row count here: an aggregate over zero rows is zero cells, and a
      // run the prune has taken from produces cells whose totals are simply too low.
      if (ctx.whole(ws, executionId, cells.length)) return cells
      // Never a merge of the two. The local aggregate is over a subset and the remote over the
      // complete ingested copy, and nothing in either says which rows they share — so summing
      // double-counts and taking the larger is a guess. The mothership's is the whole run's.
      ctx.log.debug('read-through folding a run rollup from the mothership', { executionId })
      return ctx.read<LlmCallMetricSummary[]>(
        'llmCallMetricRepository',
        'summarizeByExecution',
        ws,
        [executionId],
      )
    },
  }
}

function snapshotsReadThrough(
  local: AgentContextSnapshotRepository,
  ctx: ReadThroughContext,
): AgentContextSnapshotRepository {
  return {
    record: (snapshot) => local.record(snapshot),
    recordMany: (snapshots) => local.recordMany(snapshots),
    deleteOlderThan: (epochMs) => local.deleteOlderThan(epochMs),

    async listByExecution(ws, executionId) {
      const rows = await local.listByExecution(ws, executionId)
      if (ctx.whole(ws, executionId, rows.length)) return rows
      const older = await drainPages<AgentContextSnapshot>(
        {
          pageSize: TELEMETRY_READ_PAGE_SIZES.snapshots,
          cap: DRAIN_CAPS.snapshots - rows.length,
          cursor: cursorAfter(rows),
          log: ctx.log,
          what: 'dispatch snapshots',
          executionId,
        },
        (cursor, pageLimit) =>
          ctx.read<AgentContextSnapshot[]>('agentContextSnapshotRepository', 'listRunPage', ws, [
            { executionId, limit: pageLimit, cursor } satisfies AgentContextRunPageQuery,
          ]),
      )
      return [...rows, ...older]
    },

    async listRunPage(ws, query: AgentContextRunPageQuery) {
      const rows = await local.listRunPage(ws, query)
      if (pageIsAnswerable(ctx, ws, query.executionId, rows.length, query.limit)) return rows
      return ctx.read<AgentContextSnapshot[]>('agentContextSnapshotRepository', 'listRunPage', ws, [
        query,
      ])
    },

    async listIndex(ws, query: AgentContextIndexQuery) {
      const rows = await local.listIndex(ws, query)
      if (pageIsAnswerable(ctx, ws, query.executionId, rows.length, query.limit)) return rows
      return ctx.read<AgentContextSnapshotIndex[]>(
        'agentContextSnapshotRepository',
        'listIndex',
        ws,
        [query],
      )
    },

    async get(ws, id) {
      const row = await local.get(ws, id)
      if (row) return row
      return ctx.read<AgentContextSnapshot | null>('agentContextSnapshotRepository', 'get', ws, [
        id,
      ])
    },

    async countByExecution(ws, executionId) {
      const n = await local.countByExecution(ws, executionId)
      if (ctx.whole(ws, executionId, n)) return n
      return ctx.read<number>('agentContextSnapshotRepository', 'countByExecution', ws, [
        executionId,
      ])
    },
  }
}

function searchQueriesReadThrough(
  local: AgentSearchQueryRepository,
  ctx: ReadThroughContext,
): AgentSearchQueryRepository {
  return {
    record: (query) => local.record(query),
    recordMany: (queries) => local.recordMany(queries),
    deleteOlderThan: (epochMs) => local.deleteOlderThan(epochMs),

    async listByExecution(ws, executionId) {
      const rows = await local.listByExecution(ws, executionId)
      if (ctx.whole(ws, executionId, rows.length)) return rows
      // Searches need no `listRunPage` of their own: this sink's `listPage` already returns
      // WHOLE rows on the same keyset (the query text is capped at capture, so there is no
      // unbounded body to slice), so the drain rides it directly.
      const older = await drainPages<AgentSearchQuery>(
        {
          pageSize: TELEMETRY_READ_PAGE_SIZES.searchQueries,
          cap: DRAIN_CAPS.searchQueries - rows.length,
          cursor: cursorAfter(rows),
          log: ctx.log,
          what: 'searches',
          executionId,
        },
        (cursor, pageLimit) =>
          ctx.read<AgentSearchQuery[]>('agentSearchQueryRepository', 'listPage', ws, [
            { executionId, limit: pageLimit, cursor } satisfies AgentSearchQueryPageQuery,
          ]),
      )
      return [...rows, ...older]
    },

    async listPage(ws, query: AgentSearchQueryPageQuery) {
      const rows = await local.listPage(ws, query)
      if (pageIsAnswerable(ctx, ws, query.executionId, rows.length, query.limit)) return rows
      return ctx.read<AgentSearchQuery[]>('agentSearchQueryRepository', 'listPage', ws, [query])
    },

    async countByExecution(ws, executionId) {
      const n = await local.countByExecution(ws, executionId)
      if (ctx.whole(ws, executionId, n)) return n
      return ctx.read<number>('agentSearchQueryRepository', 'countByExecution', ws, [executionId])
    },
  }
}

/**
 * The body window to send for a point read, filling in the method's declared ceiling when the
 * caller supplied none.
 *
 * An absent window means "the whole bodies" to the port, which is the unstated size the machine
 * surface refuses — so passing the caller's `undefined` straight through would turn a legitimate
 * local miss into a 422. The ceiling is the most the surface will serve anyway, and the slice is
 * self-describing (`totalChars` beside the text), so a longer body reports itself as cut rather
 * than passing as whole.
 */
function withDeclaredBodyCap(
  repo: TelemetryReadRepository,
  method: string,
  window: LlmCallBodyWindow | undefined,
): LlmCallBodyWindow | undefined {
  if (window?.chars != null) return window
  const cap = telemetryReadBodyCap(repo, method)
  return cap == null ? window : { ...window, chars: cap }
}
