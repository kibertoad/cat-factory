import type {
  AgentJobHandle,
  LlmToolSpan,
  LlmTraceSink,
  Logger,
  StoreAgentContextGate,
} from '@cat-factory/kernel'
import { describeError, runBestEffort } from '@cat-factory/kernel'
import type { ToolCallsRecordInput } from '@cat-factory/orchestration'

// The tool-loop half of a container job's poll drain, extracted from `ContainerAgentExecutor`
// so the two destinations a drained batch reaches live together (and so the executor stays
// inside its size budget). The sibling of `containerAgentLogging.ts` and `agentContextRecord.ts`.
//
// A harness buffers each completed tool call and hands the backend a window's worth on its
// existing job poll (drain-on-read). That batch is what an operator, or an auditor reading the
// merged PR, needs to answer "HOW did this diff come about" — which command ran, against what,
// and what came back. It reaches two places, deliberately different in kind:
//
//  - the TRACE sink, as child spans under the run's trace, for the live picture; and
//  - the TRAJECTORY sink, as persisted rows, for the picture that survives the run, the
//    container, and the trace backend's own retention.
//
// Neither can be allowed to affect the job's lifecycle, so both are isolated best-effort. They
// are independent: a deployment with no trace destination still persists its trajectory, and a
// deployment whose telemetry store is unwired still emits spans.

/** Record a poll window's drained tool calls as trajectory rows. */
export type RecordToolCalls = (input: ToolCallsRecordInput) => Promise<void>

/** Where a drained batch goes, and whether its bodies may be kept. */
export interface ToolTrajectoryDeps {
  llmTraceSink?: LlmTraceSink
  recordToolCalls?: RecordToolCalls
  /**
   * The double gate on a tool call's captured `args`/`result`: the deployment's
   * `LLM_RECORD_PROMPTS` switch AND the workspace's `storeAgentContext`, composed by the facade
   * into one predicate.
   *
   * Applied HERE rather than in either destination, because both of them receive the same bodies
   * and a gate read per destination is how two answers get to disagree — a body withheld from
   * the store and shipped to an external trace backend anyway is precisely the defect the shared
   * gate exists to prevent.
   *
   * Absent ⇒ bodies are WITHHELD. An unwired gate is a facade that has not said what its
   * deployment permits, and the safe reading of silence is "not permitted"; the calls still flow
   * with `bodies: 'withheld'`, which SAYS so, rather than arriving as tools that took no
   * arguments.
   */
  toolBodyGate?: StoreAgentContextGate
}

/**
 * Fan one poll window's tool calls out to both destinations.
 *
 * The batch is passed to each destination WHOLE rather than per call: the harness already
 * bounded it to one poll interval, and a per-call loop over either destination would be the
 * banned N+1 write against a store that is append-heavy by design.
 *
 * A job dispatched OUTSIDE a run is still traced under the job's own id (a standalone trace is
 * better than an unattributed span), but a run id is all the trace tree needs. A trajectory ROW
 * additionally needs a workspace: it is workspace-scoped state, and a job with no workspace has
 * nowhere to file one, so it is skipped rather than filed under a placeholder that would put one
 * deployment's tool calls in another's reads.
 */
export async function drainToolCalls(
  deps: ToolTrajectoryDeps,
  handle: AgentJobHandle,
  captured: LlmToolSpan[] | undefined,
  logger: Logger,
): Promise<void> {
  if (!captured || captured.length === 0) return
  const executionId = handle.runId ?? handle.jobId
  const agentKind = handle.agentKind ?? 'agent'
  const spans = await gateBodies(deps.toolBodyGate, handle.workspaceId ?? null, captured, logger)
  const traceSink = deps.llmTraceSink
  if (traceSink?.recordToolSpans) {
    await runBestEffort(logger, 'containerAgent.recordToolSpans', () =>
      traceSink.recordToolSpans?.(
        { workspaceId: handle.workspaceId ?? null, executionId, agentKind, jobId: handle.jobId },
        spans,
      ),
    )
  }
  const record = deps.recordToolCalls
  const workspaceId = handle.workspaceId
  if (record && workspaceId) {
    await runBestEffort(logger, 'containerAgent.recordToolCalls', () =>
      record({ workspaceId, executionId, agentKind, jobId: handle.jobId, spans }),
    )
  }
}

/**
 * Apply the body gate to a captured batch, blanking `args`/`result` and MARKING each call as
 * withheld when it refuses.
 *
 * Marked rather than merely blanked: an empty `args` on a `stored` call means the tool took no
 * arguments, and that is a claim about the run this function is in no position to make.
 *
 * A gate that THROWS fails closed — an unreadable settings row is not consent — but the batch is
 * still forwarded, because losing a run's whole trajectory to a settings-store hiccup would trade
 * a privacy bug for an observability one.
 */
async function gateBodies(
  gate: StoreAgentContextGate | undefined,
  workspaceId: string | null,
  spans: LlmToolSpan[],
  logger: Logger,
): Promise<LlmToolSpan[]> {
  let allowed = false
  if (gate) {
    try {
      allowed = await gate(workspaceId)
    } catch (error) {
      logger.warn('tool-call bodies withheld: workspace settings unreadable', {
        scope: 'tool-trajectory',
        workspaceId,
        ...describeError(error),
      })
    }
  }
  if (allowed) return spans
  return spans.map((span) => ({
    ...span,
    bodies: 'withheld' as const,
    args: '',
    result: '',
    argsDropped: 0,
    resultDropped: 0,
  }))
}
