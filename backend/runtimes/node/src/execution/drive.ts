import type { AgentFailureKind } from '@cat-factory/kernel'
import type { AdvanceResult } from '@cat-factory/orchestration'
import type { Logger, ServerContainer } from '@cat-factory/server'

type ExecutionService = ServerContainer['executionService']

export interface DriveConfig {
  jobPollIntervalMs: number
  jobMaxPolls: number
  jobPollFailureTolerance: number
  ciPollIntervalMs: number
  ciMaxPolls: number
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

/**
 * Drive one run to a standstill, mirroring the Cloudflare ExecutionWorkflow but with
 * plain async sleeps instead of durable steps. It contains NO business logic — every
 * decision lives in `ExecutionService`. On a human decision it parks (returns); the
 * pg-boss runner re-enqueues an advance when the decision is resolved. All run state
 * lives in Postgres, so a re-run after a crash simply reads the current state.
 */
export async function driveExecution(
  exec: ExecutionService,
  workspaceId: string,
  executionId: string,
  cfg: DriveConfig,
  log: Logger,
): Promise<void> {
  const fail = (message: string, kind: AgentFailureKind = 'agent') =>
    exec.failRun(workspaceId, executionId, message, kind)

  // Poll a parked gate (job / CI / conflicts) until it yields a non-awaiting result
  // or the budget is spent. Tolerates a bounded run of status-read failures.
  const pollUntil = async (
    awaiting: AdvanceResult['kind'],
    poll: () => Promise<AdvanceResult>,
    intervalMs: number,
    maxPolls: number,
    label: string,
  ): Promise<AdvanceResult | null> => {
    let readFailures = 0
    let result: AdvanceResult = { kind: awaiting } as AdvanceResult
    for (let p = 0; p < maxPolls; p++) {
      await sleep(intervalMs)
      try {
        result = await poll()
      } catch {
        readFailures += 1
        if (readFailures >= cfg.jobPollFailureTolerance) {
          await fail(`${label} status was unreadable (${readFailures} polls)`, 'timeout')
          return null
        }
        continue
      }
      readFailures = 0
      if (result.kind !== awaiting) return result
    }
    await fail(`${label} did not settle within its polling budget`, 'timeout')
    return null
  }

  for (;;) {
    let result: AdvanceResult
    try {
      result = await exec.advanceInstance(workspaceId, executionId, { rethrowAgentErrors: true })
    } catch (error) {
      await fail(error instanceof Error ? error.message : String(error))
      return
    }

    if (result.kind === 'awaiting_job') {
      const next = await pollUntil(
        'awaiting_job',
        () => exec.pollAgentJob(workspaceId, executionId),
        cfg.jobPollIntervalMs,
        cfg.jobMaxPolls,
        'Implementation job',
      )
      if (!next) return
      result = next
    }
    if (result.kind === 'awaiting_ci') {
      const next = await pollUntil(
        'awaiting_ci',
        () => exec.pollCi(workspaceId, executionId),
        cfg.ciPollIntervalMs,
        cfg.ciMaxPolls,
        'CI',
      )
      if (!next) return
      result = next
    }
    if (result.kind === 'awaiting_conflicts') {
      const next = await pollUntil(
        'awaiting_conflicts',
        () => exec.pollConflicts(workspaceId, executionId),
        cfg.ciPollIntervalMs,
        cfg.ciMaxPolls,
        'PR mergeability',
      )
      if (!next) return
      result = next
    }

    if (result.kind === 'job_failed') {
      await fail(result.error, 'job_failed')
      return
    }
    if (result.kind === 'job_evicted') {
      await fail(result.error, 'evicted')
      return
    }
    // done / noop / paused: stop. awaiting_decision: park (resumed on signalDecision).
    if (result.kind === 'done' || result.kind === 'noop' || result.kind === 'paused') return
    if (result.kind === 'awaiting_decision') {
      log.info(
        { workspaceId, executionId, decisionId: result.decisionId },
        'run parked on decision',
      )
      return
    }
    // 'continue': loop and advance the next step.
  }
}
