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
  type MachineTelemetryReadClient,
  type TelemetryReadRepository,
} from '@cat-factory/server'

// The mothership-mode telemetry READ-THROUGH, on the LOCAL side (docs/initiatives/mothership-mode.md,
// PR 5 — the last piece of the telemetry bucket).
//
// Telemetry is captured on the laptop and pruned there on a short window; a quiesced run's rows
// are carried up to the mothership by the ingest sweep. Both halves are about the WRITE
// direction, and what they leave is a node that renders two kinds of run blank:
//
//   - one it drove whose local rows have since been pruned, and
//   - one somebody ELSE drove, whose rows were never local at all — the common case, because a
//     mothership-mode SPA shows the whole org's board.
//
// Neither reports a problem: an empty observability panel, a zero rollup and an absent search log
// are exactly what a run that spent nothing looks like. This decorator closes that by asking the
// mothership when — and only when — the LOCAL store answers with nothing.
//
// Three properties are load-bearing.
//
// **Local always wins where it has rows.** The local store is the fresher copy (it holds the run
// in flight, before any ingest) and the cheaper one. The fallback is reached only on a genuinely
// empty local answer, so a run this node is driving never pays for a round trip once it has
// recorded its first call.
//
// **A failed fallback THROWS; it never degrades to the empty answer it was called to replace.**
// The whole defect being fixed is that "no rows here" and "no rows anywhere" render identically,
// so a swallowed failure would reinstate it with an extra step. The one caller on a hot path
// (`RunStateMachine.attachStepMetrics`, which rolls a run's spend onto the emitted steps) already
// treats a metrics read as best-effort and swallows, so a mothership outage costs a board counter
// rather than the run.
//
// **It composes with keyset paging rather than fighting it.** A debug client walking a run's
// pages gets local rows while local has them and falls through to the mothership on the first
// page local cannot fill — with the SAME cursor, which is exact because the ingest preserves each
// row's id and `createdAt`. So a run whose oldest rows were pruned stitches back together across
// the two stores instead of stopping at the seam.

/** The three run-scoped telemetry repositories this decorates. */
export interface ReadThroughTelemetryRepositories {
  llmCallMetricRepository: LlmCallMetricRepository
  agentContextSnapshotRepository: AgentContextSnapshotRepository
  agentSearchQueryRepository: AgentSearchQueryRepository
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
 * Wrap `local` so that a read finding nothing locally is answered from the mothership.
 *
 * Only READS are decorated. `record` / `recordMany` / `latestChainTip` / `deleteOlderThan` pass
 * straight through to the local store: the first three are the capture hot path (the whole reason
 * this bucket is local-first), the chain tip must resolve against the rows this node actually
 * holds or it would compute a prompt delta against a tip it cannot reproduce, and the prune owns
 * local rows only.
 */
export function withTelemetryReadThrough(
  local: ReadThroughTelemetryRepositories,
  client: MachineTelemetryReadClient,
  logger?: Logger,
): ReadThroughTelemetryRepositories {
  const log = (logger ?? noopLogger).child({ scope: 'telemetryReadThrough' })
  const read = <T>(
    repo: TelemetryReadRepository,
    method: string,
    workspaceId: string,
    args: unknown[],
  ): Promise<T> => client.read({ workspaceId, repo, method, args }) as Promise<T>

  return {
    llmCallMetricRepository: metricsReadThrough(local.llmCallMetricRepository, read, log),
    agentContextSnapshotRepository: snapshotsReadThrough(
      local.agentContextSnapshotRepository,
      read,
      log,
    ),
    agentSearchQueryRepository: searchQueriesReadThrough(
      local.agentSearchQueryRepository,
      read,
      log,
    ),
  }
}

/** Perform one bounded read against the mothership, with the workspace as the bound scope. */
type RemoteRead = <T>(
  repo: TelemetryReadRepository,
  method: string,
  workspaceId: string,
  args: unknown[],
) => Promise<T>

/** A row of any of the three sinks, reduced to what the shared keyset drain needs. */
interface KeysetRow {
  id: string
  createdAt: number
}

/**
 * Page a remote read forwards from newest to oldest until it is exhausted or `cap` rows have been
 * collected, cursoring on the `(createdAt, id)` composite every telemetry read orders by.
 *
 * Reaching the cap is REPORTED rather than silently returned as a complete list: the caller is
 * rendering a run, and a list that quietly stops partway reads as the whole of it.
 */
async function drainPages<T extends KeysetRow>(
  pageSize: number,
  cap: number,
  fetchPage: (cursor: KeysetRow | undefined, limit: number) => Promise<T[]>,
  onCapped: (collected: number) => void,
): Promise<T[]> {
  const rows: T[] = []
  let cursor: KeysetRow | undefined
  while (rows.length < cap) {
    // Never ask for more than the cap still allows, so the last page is not over-fetched.
    const want = Math.min(pageSize, cap - rows.length)
    const page = await fetchPage(cursor, want)
    rows.push(...page)
    // A SHORT page means the store had no more, and terminating on it is what makes the drain
    // finite. A full one may or may not — finding out costs another request, which is exactly
    // what the next iteration is.
    if (page.length < want) return rows
    const last = page[page.length - 1]
    if (!last) return rows
    cursor = { createdAt: last.createdAt, id: last.id }
  }
  // Stopped ON the cap rather than on an exhausted store. It is possible the run held exactly
  // this many rows and nothing was actually dropped — distinguishing the two would cost one more
  // request per drain, and reporting a cap that happened to be exact is the cheaper error.
  onCapped(rows.length)
  return rows
}

function metricsReadThrough(
  local: LlmCallMetricRepository,
  read: RemoteRead,
  log: Logger,
): LlmCallMetricRepository {
  return {
    // Capture + prune + chain-tip: local only. See the module note.
    record: (metric) => local.record(metric),
    recordMany: (metrics) => local.recordMany(metrics),
    latestChainTip: (ws, ex, kind) => local.latestChainTip(ws, ex, kind),
    deleteOlderThan: (epochMs) => local.deleteOlderThan(epochMs),
    listRunPage: (ws, query) => local.listRunPage(ws, query),

    async listByExecution(ws, executionId, limit, agentKind) {
      const rows = await local.listByExecution(ws, executionId, limit, agentKind)
      if (rows.length > 0) return rows
      const cap = limit ?? DRAIN_CAPS.metrics
      return drainPages<LlmCallMetric>(
        TELEMETRY_READ_PAGE_SIZES.metrics,
        cap,
        (cursor, pageLimit) =>
          read<LlmCallMetric[]>('llmCallMetricRepository', 'listRunPage', ws, [
            { executionId, agentKind, limit: pageLimit, cursor } satisfies LlmCallRunPageQuery,
          ]),
        (collected) =>
          log.warn("read-through capped a run's calls", { executionId, cap, collected }),
      )
    },

    async listPage(ws, query: LlmCallPageQuery) {
      const rows = await local.listPage(ws, query)
      if (rows.length > 0) return rows
      return read<LlmCallMetricPage[]>('llmCallMetricRepository', 'listPage', ws, [query])
    },

    async get(ws, id, body?: LlmCallBodyWindow) {
      const row = await local.get(ws, id, body)
      if (row) return row
      return read<LlmCallMetricPage | null>('llmCallMetricRepository', 'get', ws, [id, body])
    },

    async summarizeByExecution(ws, executionId) {
      const cells = await local.summarizeByExecution(ws, executionId)
      if (cells.length > 0) return cells
      return read<LlmCallMetricSummary[]>('llmCallMetricRepository', 'summarizeByExecution', ws, [
        executionId,
      ])
    },
  }
}

function snapshotsReadThrough(
  local: AgentContextSnapshotRepository,
  read: RemoteRead,
  log: Logger,
): AgentContextSnapshotRepository {
  return {
    record: (snapshot) => local.record(snapshot),
    recordMany: (snapshots) => local.recordMany(snapshots),
    deleteOlderThan: (epochMs) => local.deleteOlderThan(epochMs),
    listRunPage: (ws, query) => local.listRunPage(ws, query),

    async listByExecution(ws, executionId) {
      const rows = await local.listByExecution(ws, executionId)
      if (rows.length > 0) return rows
      return drainPages<AgentContextSnapshot>(
        TELEMETRY_READ_PAGE_SIZES.snapshots,
        DRAIN_CAPS.snapshots,
        (cursor, pageLimit) =>
          read<AgentContextSnapshot[]>('agentContextSnapshotRepository', 'listRunPage', ws, [
            { executionId, limit: pageLimit, cursor } satisfies AgentContextRunPageQuery,
          ]),
        (collected) =>
          log.warn("read-through capped a run's dispatch snapshots", {
            executionId,
            cap: DRAIN_CAPS.snapshots,
            collected,
          }),
      )
    },

    async listIndex(ws, query: AgentContextIndexQuery) {
      const rows = await local.listIndex(ws, query)
      if (rows.length > 0) return rows
      return read<AgentContextSnapshotIndex[]>('agentContextSnapshotRepository', 'listIndex', ws, [
        query,
      ])
    },

    async get(ws, id) {
      const row = await local.get(ws, id)
      if (row) return row
      return read<AgentContextSnapshot | null>('agentContextSnapshotRepository', 'get', ws, [id])
    },

    async countByExecution(ws, executionId) {
      const n = await local.countByExecution(ws, executionId)
      if (n > 0) return n
      return read<number>('agentContextSnapshotRepository', 'countByExecution', ws, [executionId])
    },
  }
}

function searchQueriesReadThrough(
  local: AgentSearchQueryRepository,
  read: RemoteRead,
  log: Logger,
): AgentSearchQueryRepository {
  return {
    record: (query) => local.record(query),
    recordMany: (queries) => local.recordMany(queries),
    deleteOlderThan: (epochMs) => local.deleteOlderThan(epochMs),

    async listByExecution(ws, executionId) {
      const rows = await local.listByExecution(ws, executionId)
      if (rows.length > 0) return rows
      // Searches need no `listRunPage` of their own: this sink's `listPage` already returns
      // WHOLE rows on the same keyset (the query text is capped at capture, so there is no
      // unbounded body to slice), so the drain rides it directly.
      return drainPages<AgentSearchQuery>(
        TELEMETRY_READ_PAGE_SIZES.searchQueries,
        DRAIN_CAPS.searchQueries,
        (cursor, pageLimit) =>
          read<AgentSearchQuery[]>('agentSearchQueryRepository', 'listPage', ws, [
            { executionId, limit: pageLimit, cursor } satisfies AgentSearchQueryPageQuery,
          ]),
        (collected) =>
          log.warn("read-through capped a run's searches", {
            executionId,
            cap: DRAIN_CAPS.searchQueries,
            collected,
          }),
      )
    },

    async listPage(ws, query: AgentSearchQueryPageQuery) {
      const rows = await local.listPage(ws, query)
      if (rows.length > 0) return rows
      return read<AgentSearchQuery[]>('agentSearchQueryRepository', 'listPage', ws, [query])
    },

    async countByExecution(ws, executionId) {
      const n = await local.countByExecution(ws, executionId)
      if (n > 0) return n
      return read<number>('agentSearchQueryRepository', 'countByExecution', ws, [executionId])
    },
  }
}
