// Persistence port for the TOOL-CALL TRAJECTORY: one row per tool invocation an agent
// made, in the order it made them. The fourth telemetry sink, and the one that answers
// a question the other three cannot.
//
//  - `llm-metrics.ts` records what each model call COST and what text crossed the wire;
//  - `agent-context.ts` records the context one dispatch was PROVIDED;
//  - `agent-search-queries.ts` records the web searches an agent PERFORMED;
//  - this records everything else the agent DID: which tool, with what arguments, what
//    came back, in what order, and whether it worked.
//
// Before it, an agent's tool loop survived a run only as the spans a trace sink happened
// to be wired for (metadata, no arguments, no results, nothing persisted) — so
// reconstructing "how" a diff came about meant diffing consecutive prompt bodies against
// each other and inferring the tool loop from what appeared between them. A trajectory
// that is only reconstructible is not evidence.
//
// Lives in the isolated telemetry store beside the other three (a separate D1 database on
// Cloudflare, a `telemetry` Postgres schema on Node) and rides the same retention window.
// Bodies are gated the same way as the other two body-bearing sinks: the deployment
// prompt-recording switch AND the workspace `storeAgentContext` setting. The domain
// depends only on this interface; each runtime facade implements it.

// The row is the wire-returned shape of the debug tool-call endpoints, so its single
// source of truth is the valibot schema in `@cat-factory/contracts`; re-exported here so
// the port and the route contract can't drift. The recorder/repository interfaces below
// stay in kernel (they have no wire form).
import type { AgentToolCall, ToolCallBodiesState } from '@cat-factory/contracts'
export type { AgentToolCall, ToolCallBodiesState }

/**
 * The fields a producer hands the recorder. The service assigns `id` (derived from
 * `(jobId, seq)`, so re-recording a call is a no-op at the store) and `createdAt`.
 */
export type RecordAgentToolCallInput = Omit<AgentToolCall, 'id' | 'createdAt'>

/**
 * The recorder the container-executor poll site calls with each drained batch
 * (best-effort). The implementation applies the body gate and the capture caps, then
 * persists via the repository below. Defined here so the server layer depends only on
 * this interface.
 *
 * A BATCH method rather than a single-row one: the harness drains a poll window's worth
 * of calls at once, and looping a single-row recorder over them is the banned N+1 write.
 */
export interface AgentToolCallRecorder {
  record(calls: RecordAgentToolCallInput[]): Promise<void>
}

/** A bounded, keyset-paginated query over one run's tool calls. */
export interface AgentToolCallPageQuery {
  executionId: string
  limit: number
  /** EXCLUSIVE keyset on the `(createdAt, id)` composite the ordering uses. */
  cursor?: { createdAt: number; id: string }
  /**
   * Restrict to one dispatch's trajectory. A run's step can dispatch more than once, and
   * an operator reading "what did the third ci-fixer round actually do" wants that round
   * alone rather than every round interleaved by timestamp.
   */
  jobId?: string
}

export interface AgentToolCallRepository {
  /**
   * Append a batch of tool calls in one round trip, IGNORING any whose id is already
   * stored.
   *
   * Idempotent by id BY CONSTRUCTION, for two reasons rather than one: the durable poll
   * path can re-drive a poll whose recording already committed, and the mothership-mode
   * telemetry ingest (`POST /internal/telemetry/ingest`) retries a chunk whose ack was
   * lost. A duplicate must not abort the rest of the batch.
   *
   * FIRST WRITE WINS, never an upsert: a re-offered call is byte-identical to the stored
   * one, so there is nothing to correct and an upsert would only invite a later producer
   * to overwrite a trajectory row with a differently-truncated body.
   *
   * An empty batch is a no-op, not an error — the ingest drains until a page comes back
   * empty.
   */
  recordMany(calls: AgentToolCall[]): Promise<void>
  /**
   * A run's tool calls in TRAJECTORY order: oldest first, `(jobId, seq)` ascending.
   *
   * The one read in this port that does not order by the `(createdAt, id)` keyset every
   * other telemetry list uses, because a trajectory's meaning IS its order and a
   * millisecond-resolution timestamp cannot carry it: a tool loop routinely fires several
   * calls inside one millisecond, and `seq` is the only thing that separates them. Bounded
   * by `limit`, applied to the OLDEST end, so a truncated read is a prefix of the run
   * rather than a middle slice with no beginning.
   */
  listByExecution(workspaceId: string, executionId: string, limit: number): Promise<AgentToolCall[]>
  /**
   * One BOUNDED page, newest first on the `(createdAt, id)` keyset — the shape the debug
   * fan-out lists share, so a caller paging every sink of a run pages them alike. Bodies
   * come back whole: they are capped at CAPTURE time (unlike a prompt body, which is
   * stored unbounded and sliced at read time), so there is no offset read to serve.
   */
  listPage(workspaceId: string, query: AgentToolCallPageQuery): Promise<AgentToolCall[]>
  /** How many tool calls the run made — one indexed COUNT, no rows read. */
  countByExecution(workspaceId: string, executionId: string): Promise<number>
  /**
   * Retention: delete rows older than `epochMs` (exclusive), returning how many were
   * removed. Pruned to the same window as the per-call LLM telemetry.
   */
  deleteOlderThan(epochMs: number): Promise<number>
}
