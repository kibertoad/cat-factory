import type {
  AgentToolCall,
  AgentToolCallPageQuery,
  AgentToolCallRecorder,
  AgentToolCallRepository,
  Clock,
  LlmToolSpan,
  Logger,
  RecordAgentToolCallInput,
  WorkspaceSettingsRepository,
} from '@cat-factory/kernel'
import { DEFAULT_WORKSPACE_SETTINGS, describeError, noopLogger } from '@cat-factory/kernel'

/**
 * Backstop cap (characters) the service applies to a stored `args`/`result`.
 *
 * The harness caps at capture time already, and that cap is the one that keeps the drain
 * buffer and the poll response small. This one exists because the producer is an IMAGE a
 * workspace pins independently of the backend: a pool running a build with a laxer cap (or
 * none) must not be able to push a row the store rejects for exceeding a per-value limit,
 * which would lose the whole batch rather than one body's tail. Sized well above the
 * harness cap so it is inert in the normal case.
 */
export const MAX_TOOL_BODY_CHARS = 16 * 1024

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
  workspaceSettingsRepository: WorkspaceSettingsRepository
  clock: Clock
  /**
   * The deployment's prompt-recording switch (`LLM_RECORD_PROMPTS`, default true). When
   * false the operator has opted out of retaining model-adjacent text, so a call's
   * arguments and result are dropped here too — the operator opt-out wins over the
   * per-workspace toggle.
   */
  recordPrompts?: boolean
  logger?: Logger
}

/**
 * The tool-call trajectory sink: what an agent DID, one row per tool invocation, in the
 * order it made them. A sibling of {@link AgentContextObservabilityService} (what the agent
 * was GIVEN) and {@link SearchQueryObservabilityService} (what it SEARCHED).
 *
 * The METADATA of a call (which tool, when, whether it worked) is always recorded: it
 * carries no model- or user-authored text, it is what makes a stalled run legible after
 * the fact, and a deployment that could not see its agents' tool loops at all was the gap
 * this sink closes. The BODIES are gated twice, exactly like the other two body-bearing
 * sinks: the deployment-wide {@link recordPrompts} switch AND the per-workspace
 * `storeAgentContext` setting. A withheld body is RECORDED AS withheld rather than stored
 * as an empty string, because "the operator opted out" and "the tool took no arguments"
 * are different facts and a reader that cannot tell them apart will read the first as the
 * second.
 *
 * A settings read that THROWS fails closed (bodies withheld, metadata still recorded): an
 * unreadable settings row is not consent, and losing a run's whole trajectory over a store
 * hiccup would trade a privacy bug for an observability one.
 */
export class ToolCallObservabilityService implements AgentToolCallRecorder {
  private readonly repository: AgentToolCallRepository
  private readonly settings: WorkspaceSettingsRepository
  private readonly clock: Clock
  private readonly recordPrompts: boolean
  private readonly log: Logger

  constructor({
    agentToolCallRepository,
    workspaceSettingsRepository,
    clock,
    recordPrompts = true,
    logger,
  }: ToolCallObservabilityServiceDependencies) {
    this.repository = agentToolCallRepository
    this.settings = workspaceSettingsRepository
    this.clock = clock
    this.recordPrompts = recordPrompts
    this.log = logger ?? noopLogger
  }

  /**
   * Persist one drained batch, stamping each row's id and capture time. The id is derived
   * from `(jobId, seq)` — the same shape `makeHarnessCallRecorder` uses for a subscription
   * harness's calls, and for the same reason: a batch reaches the store on the durable poll
   * path, which replays, so a re-recorded call must collapse onto the row it already wrote
   * instead of duplicating a step of the trajectory.
   */
  async record(calls: RecordAgentToolCallInput[]): Promise<void> {
    if (calls.length === 0) return
    // One drain is one dispatch, so one workspace: the gate is read once per batch rather
    // than once per call, which would be the banned N+1 read against the settings store.
    const bodiesAllowed = await this.bodiesAllowed(calls[0]!.workspaceId)
    const createdAt = this.clock.now()
    const rows = calls.map((call) => this.toRow(call, bodiesAllowed, createdAt))
    await this.repository.recordMany(rows)
  }

  /** A run's trajectory, oldest first — the drill-down read. */
  listByExecution(
    workspaceId: string,
    executionId: string,
    limit: number,
  ): Promise<AgentToolCall[]> {
    return this.repository.listByExecution(workspaceId, executionId, limit)
  }

  /** One bounded page of a run's trajectory, newest first on the `(createdAt, id)` keyset. */
  listPage(workspaceId: string, query: AgentToolCallPageQuery): Promise<AgentToolCall[]> {
    return this.repository.listPage(workspaceId, query)
  }

  private toRow(
    call: RecordAgentToolCallInput,
    bodiesAllowed: boolean,
    createdAt: number,
  ): AgentToolCall {
    // The producer's own state wins where it already withheld: an image that captured no
    // bodies cannot have them restored by a permissive gate here.
    const bodies = bodiesAllowed && call.bodies === 'stored' ? 'stored' : 'withheld'
    const args = bodies === 'stored' ? clamp(call.args, call.argsDropped) : { text: '', dropped: 0 }
    const result =
      bodies === 'stored' ? clamp(call.result, call.resultDropped) : { text: '', dropped: 0 }
    return {
      ...call,
      id: `${call.jobId}-tc-${call.seq}`,
      bodies,
      args: args.text,
      argsDropped: args.dropped,
      result: result.text,
      resultDropped: result.dropped,
      createdAt,
    }
  }

  private async bodiesAllowed(workspaceId: string): Promise<boolean> {
    if (!this.recordPrompts) return false
    try {
      const settings = (await this.settings.get(workspaceId)) ?? DEFAULT_WORKSPACE_SETTINGS
      return settings.storeAgentContext
    } catch (error) {
      // Fail CLOSED: an unreadable settings row is not consent. The metadata rows still
      // record, so the trajectory survives a store hiccup with its bodies withheld — and
      // the row SAYS they were withheld, so nobody reads the gap as an empty tool loop.
      this.log.warn('tool-call bodies withheld: workspace settings unreadable', {
        scope: 'tool-call-observability',
        workspaceId,
        ...describeError(error),
      })
      return false
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
