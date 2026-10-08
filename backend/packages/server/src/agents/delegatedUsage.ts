import type {
  AgentTokenUsage,
  DelegatedExecutorDefinition,
  DelegationUpdate,
  HarnessCallMetric,
  Logger,
} from '@cat-factory/kernel'
import { describeError } from '@cat-factory/kernel'
import type { HarnessCallsRecordInput } from '@cat-factory/orchestration'

// ---------------------------------------------------------------------------
// Where a delegated step's REPORTED usage becomes a call metric.
//
// The step's metrics, the run totals and `delegatedSpendUnreported` all read `llm_call_metrics`,
// not the usage ledger a completed result's `usage` is written to. A figure filed only in the
// ledger leaves the card saying "usage not reported" beside it, so it is filed here as well, as
// the same job-level row a subscription CLI's terminal total becomes.
// ---------------------------------------------------------------------------

/** The recorder the container path files a subscription harness's calls through. */
export type RecordHarnessCalls = (input: HarnessCallsRecordInput) => Promise<void>

/** The figure a settled update reports, or undefined while running or when it reports none. */
export function reportedUsage(update: DelegationUpdate): AgentTokenUsage | undefined {
  if (update.state === 'done') return update.result.usage
  if (update.state === 'failed') return update.usage
  return undefined
}

/**
 * One external run's total as a single metric row.
 *
 * `standsForJob` because there is no turn to attribute it to, and `spendOnly` false because it is
 * the job's ONLY record: a step that spent tokens must not read as one that made no calls, which
 * is what the reporting gap counts. A usage with no `inputClasses` files its whole input as fresh,
 * the same over-statement rather than under-statement the meter applies to a lumped count.
 */
export function delegatedCallMetric(usage: AgentTokenUsage, model: string): HarnessCallMetric {
  const classes = usage.inputClasses
  return {
    model,
    promptText: '',
    messageCount: 0,
    responseText: '',
    reasoningText: '',
    inputTokens: classes ? classes.promptTokens : usage.inputTokens,
    cacheReadTokens: classes?.cacheReadTokens ?? 0,
    cacheWriteTokens: classes?.cacheWriteTokens ?? 0,
    outputTokens: usage.outputTokens,
    finishReason: null,
    seq: 0,
    standsForJob: true,
    spendOnly: false,
  }
}

/**
 * File a settled update's reported usage, best-effort.
 *
 * Keyed on the dispatch's job id, so a replayed poll mints the same row id and re-recording is a
 * no-op at the store. A re-dispatch after a retryable failure is a new job id, so each external
 * run is one row. A failure here never fails the poll: telemetry is observability.
 */
export async function recordDelegatedUsage(input: {
  record: RecordHarnessCalls | undefined
  update: DelegationUpdate
  definition: DelegatedExecutorDefinition
  scope: { workspaceId: string; runId: string; agentKind: string }
  jobId: string
  logger: Logger
}): Promise<void> {
  const usage = reportedUsage(input.update)
  if (!usage || !input.record) return
  // The SAME model name the dispatch records: the executor chose its own, which we never saw.
  const model = `delegated:${input.definition.id}`
  try {
    await input.record({
      workspaceId: input.scope.workspaceId,
      executionId: input.scope.runId,
      agentKind: input.scope.agentKind,
      provider: 'delegated',
      model,
      jobId: input.jobId,
      calls: [delegatedCallMetric(usage, model)],
    })
  } catch (error) {
    input.logger.warn(
      'could not record the usage a delegated executor reported',
      describeError(error),
    )
  }
}
