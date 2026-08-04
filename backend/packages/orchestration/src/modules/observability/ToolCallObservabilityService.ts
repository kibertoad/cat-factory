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
