import type {
  AgentToolCall,
  AgentToolCallPageQuery,
  AgentToolCallRecorder,
  AgentToolCallRepository,
  AgentToolCallTrajectoryQuery,
  Clock,
  LlmToolSpan,
  Logger,
  RecordAgentToolCallInput,
} from '@cat-factory/kernel'
import { noopLogger } from '@cat-factory/kernel'
import type { RunToolCallFailures, RunToolCallTrajectory } from '@cat-factory/contracts'

/**
 * Backstop cap (characters) the service applies to a stored `args`/`result`.
 *
 * The harness caps at capture time already (2 KiB of arguments, 4 KiB of result), and that
 * cap is the one that keeps the drain buffer and the poll response small. This one exists
 * because the producer is an IMAGE a workspace pins independently of the backend: a pool
 * running a build with a laxer cap (or none) must not be able to push a row the store rejects
 * for exceeding a per-value limit, which would lose the whole batch rather than one body's
 * tail.
 *
 * It is ALSO what makes the debug list's response size computable before the request, since
 * those rows come back whole: a page is at most `limit x 2 x this`. So it is sized as a
 * generous multiple of the harness's own caps rather than an arbitrary large number — 2x the
 * result cap leaves a lax image plenty of room while keeping a full 100-row page under 2 MB.
 */
export const MAX_TOOL_BODY_CHARS = 8 * 1024

/**
 * Width the ordinal is zero-padded to inside a row id.
 *
 * The id is `<jobId>-tc-<seq>`, and the debug page's keyset breaks a tie on `(createdAt, id)`
 * — a tie that is the COMMON case here, since a whole poll window is stamped at one instant.
 * Unpadded, that tiebreak is a string compare, which puts call 19 before call 2 and hands a
 * reader a page whose order contradicts the `seq` printed on its own rows. Padding makes the
 * lexical order agree with the numeric one for any job that fits, and six digits is far past
 * what a job's inactivity and duration ceilings allow it to reach.
 */
const SEQ_ID_WIDTH = 6

/**
 * Cap on the trajectory a RENDERING surface (the observability panel) is handed.
 *
 * Sized against the panel's job rather than the store's: a tool loop fires several calls per
 * model turn, so it sits well above the LLM call list's own 1,000-row cap, and a run past it is
 * long enough that the browser, not the query, is the binding constraint. Applied to the OLDEST
 * end like every trajectory read, so a truncated one is a genuine prefix of the run — and
 * REPORTED as one, because a prefix a reader cannot recognise is a run's opening moves presented
 * as everything it did.
 */
const DEFAULT_TRAJECTORY_LIMIT = 2_000

/**
 * Cap on the FAILING calls the panel pins, read separately from the trajectory above.
 *
 * Two orders of magnitude smaller because it is bounding a different population: failures are a
 * handful among thousands, so this is a runaway guard rather than a working limit, and the
 * narrowing that makes it affordable is the one the debug API added
 * ({@link AgentToolCallTrajectoryQuery.outcome}, applied in SQL). Sizing it small is what lets
 * the panel's headline answer arrive without the trajectory's bodies behind it.
 */
const MAX_PINNED_FAILURES = 200

/** Clamp one body, reporting what it dropped rather than silently shortening. */
function clamp(text: string, alreadyDropped: number): { text: string; dropped: number } {
  if (text.length <= MAX_TOOL_BODY_CHARS) return { text, dropped: alreadyDropped }
  return {
    text: text.slice(0, MAX_TOOL_BODY_CHARS),
    dropped: alreadyDropped + (text.length - MAX_TOOL_BODY_CHARS),
  }
}

export interface ToolCallObservabilityServiceDependencies {
  agentToolCallRepository: AgentToolCallRepository
  clock: Clock
}

/**
 * The tool-call trajectory sink: what an agent DID, one row per tool invocation, in the order it
 * made them. A sibling of {@link AgentContextObservabilityService} (what the agent was GIVEN) and
 * {@link SearchQueryObservabilityService} (what it SEARCHED).
 *
 * The METADATA of a call (which tool, when, whether it worked) is always recorded: it carries no
 * model- or user-authored text, and it is what makes a stalled run legible after the fact. The
 * BODIES ride the same double gate as every other body-capturing path (`LLM_RECORD_PROMPTS` AND
 * the workspace's `storeAgentContext`), but that gate is applied ONE step upstream, at the drain
 * that fans a poll window out to both this sink and the external trace sinks — because a body
 * withheld from the store and shipped to Langfuse anyway is exactly the privacy defect the shared
 * gate exists to prevent, and reading the settings twice per drain is how the two answers get to
 * disagree.
 *
 * So this service HONOURS the `bodies` state it is handed and never upgrades it: a `withheld` call
 * is stored withheld. What it owns is the identity, the timestamp, and the backstop clamp.
 */
export class ToolCallObservabilityService implements AgentToolCallRecorder {
  private readonly repository: AgentToolCallRepository
  private readonly clock: Clock

  constructor({ agentToolCallRepository, clock }: ToolCallObservabilityServiceDependencies) {
    this.repository = agentToolCallRepository
    this.clock = clock
  }

  /**
   * Persist one drained batch, stamping each row's id and capture time. The id is derived from
   * `(jobId, seq)` — the same shape `makeHarnessCallRecorder` uses for a subscription harness's
   * calls, and for the same reason: a batch reaches the store on the durable poll path, which
   * replays, so a re-recorded call must collapse onto the row it already wrote instead of
   * duplicating a step of the trajectory.
   */
  async record(calls: RecordAgentToolCallInput[]): Promise<void> {
    if (calls.length === 0) return
    const createdAt = this.clock.now()
    await this.repository.recordMany(calls.map((call) => this.toRow(call, createdAt)))
  }

  /** A run's trajectory, oldest first — the ordered read. */
  listByExecution(
    workspaceId: string,
    query: AgentToolCallTrajectoryQuery,
  ): Promise<AgentToolCall[]> {
    return this.repository.listByExecution(workspaceId, query)
  }

  /**
   * A run's trajectory for a RENDERING surface: oldest first, capped at
   * {@link DEFAULT_TRAJECTORY_LIMIT}, and SAYING whether the cap bit.
   *
   * It is the whole prefix rather than the failing rows alone because an operator reading a
   * failure needs what led up to it. What it is NOT is the panel's source of truth about
   * failures: those come from {@link failuresForRun}, whose numbers are SQL aggregates over the
   * whole run. Deriving them here instead would make every headline on a long run a statement
   * about the run's first two thousand calls wearing the words "this run".
   *
   * Fetches one row past the cap so `truncated` is a fact rather than a guess — the same reason
   * `exportForExecution` does it, and `length === limit` guesses wrong on the run whose call
   * count lands exactly on the cap.
   */
  async listForRun(workspaceId: string, executionId: string): Promise<RunToolCallTrajectory> {
    const fetched = await this.repository.listByExecution(workspaceId, {
      executionId,
      limit: DEFAULT_TRAJECTORY_LIMIT + 1,
    })
    const truncated = fetched.length > DEFAULT_TRAJECTORY_LIMIT
    return {
      toolCalls: truncated ? fetched.slice(0, DEFAULT_TRAJECTORY_LIMIT) : fetched,
      truncated,
    }
  }

  /**
   * What the panel PINS: the run's failing tool calls, plus the exact counts behind them.
   *
   * The counts come from the store's one aggregate pass rather than from the returned rows,
   * which is the whole point of the split. `failed` is a number about the RUN; `failures` is a
   * bounded list about the same run. When they disagree, `failuresTruncated` says so and
   * `failed` stays the honest one — the alternative is a panel that counts what it happens to
   * be holding and calls it the run's failure count, which is precisely the false all-clear the
   * failing-call surface exists to prevent.
   *
   * Both reads are issued together: they hit the same `(workspace_id, execution_id)` index range
   * and the caller wants both or neither, exactly like the debug overview's five aggregates.
   */
  async failuresForRun(workspaceId: string, executionId: string): Promise<RunToolCallFailures> {
    const [counts, fetched] = await Promise.all([
      this.repository.countByExecution(workspaceId, executionId),
      this.repository.listByExecution(workspaceId, {
        executionId,
        limit: MAX_PINNED_FAILURES + 1,
        // Narrowed in SQL, not after the read: the failing calls of a long run sit past any
        // prefix of it, so a post-filter here would answer "nothing failed" on exactly the runs
        // this surface exists for.
        outcome: 'error',
      }),
    ])
    const failuresTruncated = fetched.length > MAX_PINNED_FAILURES
    return {
      total: counts.total,
      failed: counts.failed,
      failures: failuresTruncated ? fetched.slice(0, MAX_PINNED_FAILURES) : fetched,
      failuresTruncated,
    }
  }

  /** One bounded page of a run's trajectory, newest first on the `(createdAt, id)` keyset. */
  listPage(workspaceId: string, query: AgentToolCallPageQuery): Promise<AgentToolCall[]> {
    return this.repository.listPage(workspaceId, query)
  }

  private toRow(call: RecordAgentToolCallInput, createdAt: number): AgentToolCall {
    const stored = call.bodies === 'stored'
    const args = stored ? clamp(call.args, call.argsDropped) : { text: '', dropped: 0 }
    const result = stored ? clamp(call.result, call.resultDropped) : { text: '', dropped: 0 }
    return {
      ...call,
      id: `${call.jobId}-tc-${String(call.seq).padStart(SEQ_ID_WIDTH, '0')}`,
      args: args.text,
      argsDropped: args.dropped,
      result: result.text,
      resultDropped: result.dropped,
      createdAt,
    }
  }
}

/** The per-poll payload the container executor hands a tool-call recorder. */
export interface ToolCallsRecordInput {
  workspaceId: string
  executionId: string
  agentKind: string
  /** The dispatch job id: the trajectory's grouping key and half of each row's id. */
  jobId: string
  spans: LlmToolSpan[]
}

/**
 * Build the container executor's `recordToolCalls` dependency: map a drained batch of
 * harness tool spans onto the {@link ToolCallObservabilityService}. The sibling of
 * `makeHarnessCallRecorder`, and it fills the row the same deliberate way — with what the
 * producing image actually reported rather than a plausible guess.
 *
 * `bodies`, `argsDropped` and `resultDropped` are read LENIENTLY (a runner pool runs
 * whatever image its workspace pinned, and an image one release behind is the normal state
 * of running one): absent `bodies` means `withheld`, because that image captured no
 * arguments and recording its silence as `stored` would present an empty `args` as a tool
 * that took none.
 *
 * `seq` is the one field NOT defaulted. It is the row's identity as well as the
 * trajectory's order, and the only stateless substitute available here — the span's
 * position in the batch — restarts at zero on every poll window, so every window's first
 * call would mint the id of the job's first call and first-write-wins would drop them all.
 * Losing four calls in five while reporting a complete-looking trajectory is worse than
 * reporting none, so an un-numbered batch is SKIPPED and named: the run's spans still reach
 * the trace sinks, exactly as they did before this sink existed, and the operator gets a
 * line saying which job's image is too old to have its trajectory persisted.
 */
export function makeToolCallRecorder(
  service: AgentToolCallRecorder,
  logger?: Logger,
): (input: ToolCallsRecordInput) => Promise<void> {
  const log = logger ?? noopLogger
  return async ({ workspaceId, executionId, agentKind, jobId, spans }) => {
    if (spans.length === 0) return
    if (spans.some((span) => span.seq === undefined)) {
      log.warn('tool-call trajectory skipped: harness image reports no call ordinals', {
        scope: 'tool-call-observability',
        workspaceId,
        executionId,
        jobId,
        agentKind,
        spans: spans.length,
      })
      return
    }
    await service.record(
      spans.map((span) => ({
        workspaceId,
        executionId,
        agentKind,
        jobId,
        seq: span.seq ?? 0,
        tool: span.tool,
        startedAt: span.startedAt,
        endedAt: span.endedAt,
        ok: span.ok,
        bodies: span.bodies ?? ('withheld' as const),
        args: span.args ?? '',
        result: span.result ?? '',
        argsDropped: span.argsDropped ?? 0,
        resultDropped: span.resultDropped ?? 0,
      })),
    )
  }
}
