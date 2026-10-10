import type {
  AgentTokenUsage,
  DelegatedExecutorDefinition,
  DelegationUpdate,
  HarnessCallMetric,
  Logger,
} from '@cat-factory/kernel'
import { DELEGATED_USAGE_PROVIDER, partitionInputTokens, runBestEffort } from '@cat-factory/kernel'
import type { RecordHarnessCalls } from '@cat-factory/orchestration'

// ---------------------------------------------------------------------------
// Where a delegated step's REPORTED usage becomes a call metric.
//
// The step's metrics, the run totals and `delegatedSpendUnreported` all read `llm_call_metrics`,
// not the usage ledger a completed result's `usage` is written to. A figure filed only in the
// ledger leaves the card saying "usage not reported" beside it, so it is filed here as well, as
// the same job-level row a subscription CLI's terminal total becomes.
// ---------------------------------------------------------------------------

/**
 * The model name a delegated dispatch is filed under. The executor chose its own model, which the
 * platform never sees, so the row names the EXECUTOR under {@link DELEGATED_USAGE_PROVIDER} instead.
 */
export function delegatedModelName(definition: DelegatedExecutorDefinition): string {
  return `delegated:${definition.id}`
}

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
 * is what the reporting gap counts. The classes come from `partitionInputTokens` over the reported
 * total, so an external executor's split that does not sum to `inputTokens` cannot file a total
 * the ledger disagrees with, and a usage with no split files its whole input as fresh.
 */
export function delegatedCallMetric(usage: AgentTokenUsage, model: string): HarnessCallMetric {
  const classes = partitionInputTokens(
    usage.inputTokens,
    usage.inputClasses ?? { cacheReadTokens: 0, cacheWriteTokens: 0 },
  )
  return {
    model,
    promptText: '',
    messageCount: 0,
    responseText: '',
    reasoningText: '',
    inputTokens: classes.promptTokens,
    cacheReadTokens: classes.cacheReadTokens,
    cacheWriteTokens: classes.cacheWriteTokens,
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
  const { record } = input
  const usage = reportedUsage(input.update)
  if (!usage || !record) return
  const model = delegatedModelName(input.definition)
  await runBestEffort(input.logger, 'delegatedAgent.recordUsage', () =>
    record({
      workspaceId: input.scope.workspaceId,
      executionId: input.scope.runId,
      agentKind: input.scope.agentKind,
      provider: DELEGATED_USAGE_PROVIDER,
      model,
      jobId: input.jobId,
      calls: [delegatedCallMetric(usage, model)],
    }),
  )
}
