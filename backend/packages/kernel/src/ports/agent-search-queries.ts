// Persistence port for agent-search-query observability. Where `llm-metrics.ts`
// captures what the model received per proxied call and `agent-context.ts` the full
// context an agent was provided, this captures the web searches a container agent
// actually performed during a run — one row per query issued through the backend
// search proxy (`webSearchProxyController`). Recording is gated the same way as
// agent-context snapshots (the deployment prompt-recording switch AND the workspace
// `storeAgentContext` setting). It lives in the isolated telemetry store alongside
// `llm_call_metrics` (a separate D1 database on Cloudflare, a `telemetry` Postgres
// schema on Node) and rides the same retention window. The domain depends only on
// this interface; each runtime facade implements it.

// The query row is the wire-returned shape of the search-query observability endpoint,
// so its single source of truth is the valibot schema in `@cat-factory/contracts`;
// re-exported here so the port and the route contract can't drift. The recorder/
// repository interfaces below stay in kernel (they have no wire form).
import type { AgentSearchQuery } from '@cat-factory/contracts'
export type { AgentSearchQuery }

/**
 * The fields the search proxy hands to the recorder. The service assigns the `id`
 * and `createdAt`, so they are omitted here.
 */
export type RecordAgentSearchQueryInput = Omit<AgentSearchQuery, 'id' | 'createdAt'>

/**
 * The recorder the search-proxy write site calls (best-effort, after a search). The
 * implementation gates on the deployment's prompt-recording switch AND the workspace's
 * `storeAgentContext` setting, then persists via the repository below. Defined here so
 * the server-layer proxy depends only on this interface.
 */
export interface AgentSearchQueryRecorder {
  record(input: RecordAgentSearchQueryInput): Promise<void>
}

/** A bounded, keyset-paginated query over one run's performed searches. */
export interface AgentSearchQueryPageQuery {
  executionId: string
  limit: number
  /** EXCLUSIVE keyset on the `(createdAt, id)` composite the ordering uses. */
  cursor?: { createdAt: number; id: string }
}

export interface AgentSearchQueryRepository {
  /** Append one performed search query. */
  record(query: AgentSearchQuery): Promise<void>
  /**
   * Append a BATCH of performed search queries in one round trip, IGNORING any whose id is
   * already stored.
   *
   * This exists for the mothership-mode telemetry INGEST (`POST /internal/telemetry/ingest`,
   * docs/initiatives/mothership-mode.md, PR 5), which uploads a finished run's locally captured
   * searches and RETRIES a chunk whose ack was lost — so unlike the single-row
   * {@link AgentSearchQueryRepository.record}, the batch append is idempotent by id BY
   * CONSTRUCTION. Looping `record` over the batch would be the banned N+1 write; a store
   * implements this as one chunked multi-row insert.
   *
   * An empty batch is a no-op, not an error — the ingest drains until a page comes back empty.
   */
  recordMany(queries: AgentSearchQuery[]): Promise<void>
  /** Queries recorded for a run, newest first. */
  listByExecution(workspaceId: string, executionId: string): Promise<AgentSearchQuery[]>
  /**
   * One BOUNDED page of a run's searches, newest first. Unlike the other two telemetry
   * sinks these rows carry no unbounded body (the query text is capped at capture time), so
   * the page returns them whole — the bound it adds is on ROW COUNT, which a search-heavy
   * run still needs.
   */
  listPage(workspaceId: string, query: AgentSearchQueryPageQuery): Promise<AgentSearchQuery[]>
  /** How many searches the run performed — one indexed COUNT, no rows read. */
  countByExecution(workspaceId: string, executionId: string): Promise<number>
  /**
   * Retention: delete rows older than `epochMs` (exclusive), returning how many were
   * removed. Pruned to the same window as the per-call LLM telemetry.
   */
  deleteOlderThan(epochMs: number): Promise<number>
}
