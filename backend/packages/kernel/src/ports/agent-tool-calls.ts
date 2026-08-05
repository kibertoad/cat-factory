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

/**
 * A bounded query over one run's tool calls in TRAJECTORY order.
 *
 * Deliberately carries no cursor: the ordered read answers "what did this run do", which is a
 * question about a bounded prefix, and a resumable keyset over the same rows is what
 * {@link AgentToolCallPageQuery} is for. Keeping the two in separate types means a cursor
 * paired with an ordering it cannot resume is not a representable state.
 */
export interface AgentToolCallTrajectoryQuery {
  executionId: string
  limit: number
  /** Restrict to one dispatch, so "what did the third ci-fixer round do, in order" composes. */
  jobId?: string
  /**
   * Restrict to calls that FAILED (`false`) or succeeded (`true`). Absent ⇒ every call.
   *
   * Applied in SQL for the same reason every other narrowing on this surface is: a filter run
   * after the read has already paid for the rows it discards, and it spends the `limit` on
   * them — which on a bounded prefix read means the failures a caller asked for can fall off
   * the end of a page filled with calls that worked.
   */
  ok?: boolean
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
  /** Restrict to failed (`false`) or successful (`true`) calls; absent ⇒ every call. */
  ok?: boolean
}

/**
 * One cell of the tool-call rollup: a run's calls of ONE tool by ONE agent kind, counted
 * with how many of them failed.
 *
 * The grain is `(agentKind, tool)` because that is the finest cut the store can aggregate
 * that a reader can act on, and both halves of it are load-bearing: the tool alone cannot
 * say which agent kept hitting it, and the kind alone cannot separate "the coder's `edit`
 * failed 34 times" (a stuck loop) from "34 of its calls across nine tools failed once each"
 * (an agent exploring). Everything coarser is a pure fold over these cells
 * (`domain/tool-call-rollup.ts`), never a second query, on the same rule the LLM rollup
 * follows: two aggregates over one population are two chances to disagree about it.
 */
export interface AgentToolCallSummary {
  agentKind: string
  tool: string
  /** How many calls of this tool the kind made. */
  calls: number
  /** How many of them came back `ok: false` — a tool-EXECUTION failure, not a model error. */
  failures: number
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
   * A run's tool calls in TRAJECTORY order: oldest first, `(startedAt, seq, id)` ascending.
   *
   * The one read in this port that does not order by the `(createdAt, id)` keyset every
   * other telemetry list uses. `createdAt` cannot carry a trajectory: it is stamped once per
   * DRAIN, so a whole poll window's calls share it. `startedAt` is stamped per CALL by the
   * harness, `seq` separates the calls that share a millisecond (a tool loop routinely fires
   * several inside one), and `id` makes the order total.
   *
   * NOT `(jobId, seq)`, though a dispatch is exactly what `seq` is scoped to: a job id is a
   * STRING (`<executionId>-<agentKind>`, plus `-<epoch>` past the first dispatch), so sorting
   * by it sorts a run's dispatches by agent-kind spelling and its re-runs `-10` before `-2`.
   * A trajectory read in an order the run never ran in is worse than an unordered set, because
   * it invites a reader to draw causal conclusions from it. Ordering by when each call actually
   * STARTED gets the dispatches in the order they happened for free, and leaves `seq` doing the
   * one job no timestamp can.
   *
   * Bounded by `limit`, applied to the OLDEST end, so a truncated read is a genuine prefix of
   * the run rather than a middle slice with no beginning.
   */
  listByExecution(
    workspaceId: string,
    query: AgentToolCallTrajectoryQuery,
  ): Promise<AgentToolCall[]>
  /**
   * One BOUNDED page, newest first on the `(createdAt, id)` keyset — the shape the debug
   * fan-out lists share, so a caller paging every sink of a run pages them alike. Bodies
   * come back whole: they are capped at CAPTURE time (unlike a prompt body, which is
   * stored unbounded and sliced at read time), so there is no offset read to serve.
   */
  listPage(workspaceId: string, query: AgentToolCallPageQuery): Promise<AgentToolCall[]>
  /**
   * The run's tool activity aggregated at the `(agentKind, tool)` grain — one GROUP BY, no
   * rows and no bodies read.
   *
   * Replaces what used to be a bare COUNT, and subsumes it: the total is a fold over these
   * cells, so the overview's tool-call count and its failure breakdown are computed from ONE
   * pass over the same rows and cannot disagree. That matters here more than it did for the
   * count alone, because the number a reader actually needs is a RATIO — a run where 34 of 36
   * calls failed and one where 34 of 3,600 did are the same absolute failure count and
   * opposite diagnoses.
   *
   * COSTLIER than the COUNT it replaces, deliberately and by a known amount: the run index
   * `(workspace_id, execution_id, created_at)` served the COUNT without touching the table,
   * while grouping needs `agent_kind`, `tool` and `ok` off each row. A covering index would buy
   * that back and is NOT worth it here: this sink is append-hot (every tool call of every run
   * writes a row) and this read happens once per debug overview, so a fifth index would tax the
   * hot path to speed up the rare one. The scan stays bounded by ONE run's rows either way.
   */
  summarizeByExecution(workspaceId: string, executionId: string): Promise<AgentToolCallSummary[]>
  /**
   * Retention: delete rows older than `epochMs` (exclusive), returning how many were
   * removed. Pruned to the same window as the per-call LLM telemetry.
   */
  deleteOlderThan(epochMs: number): Promise<number>
}
