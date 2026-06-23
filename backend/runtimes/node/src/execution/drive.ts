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

/** What a drive ended on, so the runner can schedule follow-up work (a decision timeout). */
export interface DriveOutcome {
  /** Set when the run parked awaiting a human decision/approval with this id. */
  parkedDecisionId?: string
}

/**
 * Drive one run to a standstill, mirroring the Cloudflare ExecutionWorkflow but with
 * plain async sleeps instead of durable steps. It contains NO business logic — every
 * decision lives in `ExecutionService`. On a human decision it parks (returns its id so
 * the runner can arm a timeout); the pg-boss runner re-enqueues an advance when the
 * decision is resolved. All run state lives in Postgres, so a re-run after a crash simply
 * reads the current state.
 */
export async function driveExecution(
  exec: ExecutionService,
  workspaceId: string,
  executionId: string,
  cfg: DriveConfig,
  log: Logger,
): Promise<DriveOutcome> {
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
    for (let p = 0; p < maxPolls; p++) {
      await sleep(intervalMs)
      let result: AdvanceResult
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
      return {}
    }

    // Drain whatever gate the step parked on. A gate poll can resolve to a DIFFERENT
    // gate — e.g. a `ci` step that finds CI red dispatches a `ci-fixer` and returns
    // `awaiting_job` — so loop until the result is no longer an awaiting_* gate rather
    // than relying on the next `advanceInstance` to re-establish the poll (which is why
    // the order of these checks must not matter). `pollUntil` itself is bounded, so the
    // outer guard only backstops a pathological gate↔gate ping-pong.
    let gateHops = 0
    const MAX_GATE_HOPS = 64
    while (gateHops++ < MAX_GATE_HOPS) {
      if (result.kind === 'awaiting_job') {
        const next = await pollUntil(
          'awaiting_job',
          () => exec.pollAgentJob(workspaceId, executionId),
          cfg.jobPollIntervalMs,
          cfg.jobMaxPolls,
          'Implementation job',
        )
        if (!next) return {}
        result = next
        continue
      }
      // A polling gate step (`ci` / `conflicts`): re-run its precheck between sleeps;
      // which gate is resolved inside `pollGate` from the current step, so one branch
      // drives both.
      if (result.kind === 'awaiting_gate') {
        const next = await pollUntil(
          'awaiting_gate',
          () => exec.pollGate(workspaceId, executionId),
          cfg.ciPollIntervalMs,
          cfg.ciMaxPolls,
          'Gate precheck',
        )
        if (!next) return {}
        result = next
        continue
      }
      break
    }

    if (result.kind === 'job_failed') {
      await fail(result.error, 'job_failed')
      return {}
    }
    if (result.kind === 'job_evicted') {
      await fail(result.error, 'evicted')
      return {}
    }
    // done / noop / paused: stop. awaiting_decision: park (resumed on signalDecision).
    if (result.kind === 'done' || result.kind === 'noop' || result.kind === 'paused') return {}
    if (result.kind === 'awaiting_decision') {
      log.info(
        { workspaceId, executionId, decisionId: result.decisionId },
        'run parked on decision',
      )
      return { parkedDecisionId: result.decisionId }
    }
    // 'continue': loop and advance the next step.
  }
}
