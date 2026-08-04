import type { AgentJobHandle, LlmToolSpan, LlmTraceSink, Logger } from '@cat-factory/kernel'
import { runBestEffort } from '@cat-factory/kernel'
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

/** Where a drained batch goes. Both optional: an unwired destination is simply skipped. */
export interface ToolTrajectoryDeps {
  llmTraceSink?: LlmTraceSink
  recordToolCalls?: RecordToolCalls
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
  spans: LlmToolSpan[] | undefined,
  logger: Logger,
): Promise<void> {
  if (!spans || spans.length === 0) return
  const executionId = handle.runId ?? handle.jobId
  const agentKind = handle.agentKind ?? 'agent'
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
