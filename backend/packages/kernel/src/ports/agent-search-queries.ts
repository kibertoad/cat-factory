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

export interface AgentSearchQueryRepository {
  /** Append one performed search query. */
  record(query: AgentSearchQuery): Promise<void>
  /** Queries recorded for a run, newest first. */
  listByExecution(workspaceId: string, executionId: string): Promise<AgentSearchQuery[]>
  /**
   * Retention: delete rows older than `epochMs` (exclusive), returning how many were
   * removed. Pruned to the same window as the per-call LLM telemetry.
   */
  deleteOlderThan(epochMs: number): Promise<number>
}
