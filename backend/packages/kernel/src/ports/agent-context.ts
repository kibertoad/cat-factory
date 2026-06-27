// Persistence port for agent-context observability. The per-call LLM telemetry
// (see llm-metrics.ts) captures what the model received on each proxied call, but it
// does NOT capture the complete context a container agent was *provided* before it
// ran: the fully fragment-composed system prompt, the assembled user prompt, the
// best-practice fragment bodies folded in, and — the real gap — the files injected
// into the container (`.cat-context/*`, full bodies of linked docs/tracker issues),
// which the agent reads via tools during the run and which never surface in proxy
// telemetry. One snapshot is recorded per container-agent dispatch (per step
// attempt). It lives in the isolated telemetry store alongside `llm_call_metrics`
// (a separate D1 database on Cloudflare, a `telemetry` Postgres schema on Node) and
// rides the same retention window. The domain depends only on this interface; each
// runtime facade implements it.

// The snapshot and its parts are the wire-returned shape of the agent-context
// observability endpoint, so their single source of truth is the valibot schemas in
// `@cat-factory/contracts`; re-exported here so the port and the route contract can't
// drift. The recorder/repository interfaces below stay in kernel (they have no wire form).
import type {
  AgentContextFile,
  AgentContextFragment,
  AgentContextSnapshot,
} from '@cat-factory/contracts'
export type { AgentContextFile, AgentContextFragment, AgentContextSnapshot }

/**
 * The fields the dispatch site hands to the recorder. The service assigns the `id`
 * and `createdAt`, so they are omitted here. `stepIndex` keys the snapshot to a step.
 */
export type RecordAgentContextInput = Omit<AgentContextSnapshot, 'id' | 'createdAt'>

/**
 * The recorder the container-agent dispatch site calls (best-effort, after dispatch).
 * The implementation gates on the deployment's prompt-recording switch AND the
 * workspace's `storeAgentContext` setting, then persists via the repository below.
 * Defined here so the server-layer executor depends only on this interface.
 */
export interface AgentContextRecorder {
  record(input: RecordAgentContextInput): Promise<void>
}

export interface AgentContextSnapshotRepository {
  /** Append one captured dispatch context. */
  record(snapshot: AgentContextSnapshot): Promise<void>
  /** Snapshots recorded for a run, newest first. */
  listByExecution(workspaceId: string, executionId: string): Promise<AgentContextSnapshot[]>
  /**
   * Retention: delete rows older than `epochMs` (exclusive), returning how many were
   * removed. The full prompt + injected-file bodies make this heavy, so it is pruned
   * to the same window as the per-call LLM telemetry.
   */
  deleteOlderThan(epochMs: number): Promise<number>
}
