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

/**
 * A snapshot reduced to its IDENTITY plus the SIZE of each body family — the projection the
 * remote debugging surface pages over.
 *
 * A snapshot row can be megabytes (it holds the whole composed system prompt plus the full
 * content of every injected context file), so a page of them must never carry bodies. Every
 * size here is a SQL `length()`, so listing a run's dispatches reads no body bytes at all;
 * the caller picks the one it wants and point-reads it.
 *
 * Sizes, not element counts: counting the entries of the `fragments` / `contextFiles` JSON
 * columns would mean either parsing them (which reads the very bodies this projection exists
 * to avoid) or calling `json_array_length` on a column that would fail the WHOLE page if a
 * single row were ever malformed. A length answers "is there a lot in here" just as well.
 */
export interface AgentContextSnapshotIndex {
  id: string
  agentKind: string
  stepIndex: number
  createdAt: number
  model: string | null
  harness: string | null
  systemPromptChars: number
  userPromptChars: number
  /** Serialized length of the folded best-practice fragments. */
  fragmentsChars: number
  /** Serialized length of the injected `.cat-context/*` files (bodies included). */
  contextFilesChars: number
}

/** A bounded, keyset-paginated query over one run's captured dispatches. */
export interface AgentContextIndexQuery {
  executionId: string
  /** Narrow to one step's dispatches (a retried step records one snapshot per attempt). */
  stepIndex?: number
  limit: number
  /** EXCLUSIVE keyset on the `(createdAt, id)` composite the ordering uses. */
  cursor?: { createdAt: number; id: string }
}

/**
 * A bounded, keyset-paginated query over ONE run's captured dispatches returning the snapshots
 * WHOLE — the mothership-mode READ-THROUGH read (`POST /internal/telemetry/read`,
 * docs/initiatives/mothership-mode.md, PR 5).
 *
 * Same shape as {@link AgentContextIndexQuery}, deliberately declared apart rather than reused:
 * the index query's contract is that it reads no body bytes, which is exactly what this one
 * cannot promise. A single type serving both would make "bounded" mean two different things
 * (row count here, bytes there) at the same call site.
 */
export interface AgentContextRunPageQuery {
  executionId: string
  /** Narrow to one step's dispatches (a retried step records one snapshot per attempt). */
  stepIndex?: number
  /**
   * Hard cap on rows returned. Sized SMALL by callers: one snapshot carries the whole composed
   * prompt plus every injected context file's body, so a page of them moves megabytes.
   */
  limit: number
  /** EXCLUSIVE keyset on the `(createdAt, id)` composite the ordering uses. */
  cursor?: { createdAt: number; id: string }
}

export interface AgentContextSnapshotRepository {
  /** Append one captured dispatch context. */
  record(snapshot: AgentContextSnapshot): Promise<void>
  /**
   * Append a BATCH of captured dispatch contexts in one round trip, IGNORING any whose id is
   * already stored.
   *
   * This exists for the mothership-mode telemetry INGEST (`POST /internal/telemetry/ingest`,
   * docs/initiatives/mothership-mode.md, PR 5), which uploads a finished run's locally captured
   * snapshots and RETRIES a chunk whose ack was lost — so unlike the single-row
   * {@link AgentContextSnapshotRepository.record}, which is called once per dispatch and lets a
   * duplicate id surface, the batch append is idempotent by id BY CONSTRUCTION. Looping `record`
   * over the batch would be the banned N+1 write; a store implements this as one chunked
   * multi-row insert.
   *
   * An empty batch is a no-op, not an error — the ingest drains until a page comes back empty.
   */
  recordMany(snapshots: AgentContextSnapshot[]): Promise<void>
  /** Snapshots recorded for a run, newest first. */
  listByExecution(workspaceId: string, executionId: string): Promise<AgentContextSnapshot[]>
  /**
   * One BOUNDED page of {@link AgentContextSnapshotIndex} rows for a run, newest first —
   * identity plus sizes, never a body. See the type's note for why this is not just
   * {@link AgentContextSnapshotRepository.listByExecution} with a limit.
   */
  listIndex(
    workspaceId: string,
    query: AgentContextIndexQuery,
  ): Promise<AgentContextSnapshotIndex[]>
  /**
   * One BOUNDED page of a run's snapshots WITH their bodies, newest first — the read the
   * mothership-mode read-through walks. Distinct from
   * {@link AgentContextSnapshotRepository.listByExecution}, which returns every snapshot of a
   * run in one un-resumable response: a node fetching that over the machine API is the bulk
   * read the telemetry bucket exists to forbid.
   */
  listRunPage(workspaceId: string, query: AgentContextRunPageQuery): Promise<AgentContextSnapshot[]>
  /**
   * One snapshot by id, with its bodies. Whole rather than sliced: the fragment and
   * context-file bodies live inside JSON columns, so there is no portable way to budget them
   * per element in SQL — and the recorder already caps a snapshot at a few megabytes, which
   * is an acceptable single point read. The CALLER applies the per-body budget it promised
   * its own client. Workspace-scoped, so a foreign id reads as missing.
   */
  get(workspaceId: string, id: string): Promise<AgentContextSnapshot | null>
  /** How many dispatches the run captured — one indexed COUNT, no rows read. */
  countByExecution(workspaceId: string, executionId: string): Promise<number>
  /**
   * Retention: delete rows older than `epochMs` (exclusive), returning how many were
   * removed. The full prompt + injected-file bodies make this heavy, so it is pruned
   * to the same window as the per-call LLM telemetry.
   */
  deleteOlderThan(epochMs: number): Promise<number>
}
