import {
  WorkflowEntrypoint,
  type WorkflowEvent,
  type WorkflowSleepDuration,
  type WorkflowStep,
  type WorkflowStepConfig,
} from 'cloudflare:workers'
import type { AdvanceResult, AgentFailureKind } from '@cat-factory/core'
import type { Env } from '../env'
import { buildContainer } from '../container'
import { loadConfig } from '../config'
import { logger } from '../observability/logger'
import type { ExecutionWorkflowParams } from './WorkflowsWorkRunner'

/** Per-step retry policy: failures retry a few times before the run is failed. */
const STEP_CONFIG = {
  retries: { limit: 3, delay: '5 seconds', backoff: 'exponential' },
  timeout: '5 minutes',
} satisfies WorkflowStepConfig

/**
 * Durable driver for one pipeline run. It contains NO business logic — every
 * decision lives in core's ExecutionService. Each loop iteration advances the
 * run by exactly one agent step inside a retriable, checkpointed `step.do`, then
 * either loops, parks on a human decision via `waitForEvent`, or stops. Because
 * each committed step is memoised, a crash and replay never re-issues an
 * already-completed LLM call.
 */
export class ExecutionWorkflow extends WorkflowEntrypoint<Env, ExecutionWorkflowParams> {
  override async run(
    event: WorkflowEvent<ExecutionWorkflowParams>,
    step: WorkflowStep,
  ): Promise<void> {
    const { workspaceId, executionId } = event.payload
    const execConfig = loadConfig(this.env).execution
    const decisionTimeout = execConfig.decisionTimeout as WorkflowSleepDuration
    const jobPollInterval = execConfig.jobPollInterval as WorkflowSleepDuration

    const failRun = async (
      i: number,
      message: string,
      kind: AgentFailureKind = 'agent',
    ): Promise<void> => {
      logger.warn({ workspaceId, executionId, step: i }, `failing run: ${message}`)
      await step.do(`fail-${i}`, () =>
        buildContainer(this.env).executionService.failRun(workspaceId, executionId, message, kind),
      )
    }

    for (let i = 0; ; i++) {
      let result: AdvanceResult
      try {
        result = (await step.do(`advance-${i}`, STEP_CONFIG, () =>
          buildContainer(this.env).executionService.advanceInstance(workspaceId, executionId, {
            rethrowAgentErrors: true,
          }),
        )) as AdvanceResult
      } catch (error) {
        // Retries exhausted: persist the failure and open the block for review.
        await failRun(i, error instanceof Error ? error.message : String(error))
        return
      }

      // An async step (a container coding job) dispatched and parked. Poll it
      // between durable sleeps until it finishes — each poll is its own short,
      // retriable step, so the job can run far longer than one step's timeout
      // while the driver stays cheap and survives eviction. The job's bound is
      // enforced container-side (inactivity + max-duration watchdogs); `jobMaxPolls`
      // is only a backstop in case it never reports a terminal state.
      if (result.kind === 'awaiting_job') {
        let polled = false
        // Consecutive failures to READ status — not the job failing. A coding step
        // legitimately runs long shell commands (installing deps, build/test/e2e
        // suites) that can briefly make the container unresponsive to a poll. The
        // job's real liveness is bounded container-side (inactivity + max-duration
        // watchdogs); eviction surfaces as a 404→failed value and a genuine job
        // error as job_failed — both returned, not thrown. So a *thrown* poll error
        // is always transient: tolerate a bounded run of them (reset on any good
        // poll) rather than failing a healthy long-running job on the first blip.
        let pollReadFailures = 0
        for (let p = 0; p < execConfig.jobMaxPolls; p++) {
          await step.sleep(`poll-wait-${i}-${p}`, jobPollInterval)
          try {
            result = (await step.do(`poll-${i}-${p}`, STEP_CONFIG, () =>
              buildContainer(this.env).executionService.pollAgentJob(workspaceId, executionId),
            )) as AdvanceResult
          } catch (error) {
            pollReadFailures += 1
            const message = error instanceof Error ? error.message : String(error)
            logger.warn(
              { workspaceId, executionId, step: i, poll: p, pollReadFailures, err: message },
              'poll could not read job status; treating as still running and retrying',
            )
            if (pollReadFailures >= execConfig.jobPollFailureTolerance) {
              await failRun(
                i,
                `Job status was unreadable for ${pollReadFailures} consecutive polls; ` +
                  `the container appears unreachable (last error: ${message})`,
                'timeout',
              )
              return
            }
            continue
          }
          pollReadFailures = 0
          if (result.kind !== 'awaiting_job') {
            polled = true
            break
          }
        }
        if (!polled && result.kind === 'awaiting_job') {
          await failRun(i, 'Implementation job did not finish within its polling budget', 'timeout')
          return
        }
      }

      if (result.kind === 'job_failed') {
        await failRun(i, result.error, 'job_failed')
        return
      }

      // 'paused' means the spend budget is exhausted: stop driving this run.
      // The /spend/resume endpoint re-creates the workflow once it frees up.
      if (result.kind === 'done' || result.kind === 'noop' || result.kind === 'paused') return

      if (result.kind === 'awaiting_decision') {
        const decisionId = result.decisionId
        try {
          await step.waitForEvent(`await-${decisionId}`, {
            type: `decision-${decisionId}`,
            timeout: decisionTimeout,
          })
        } catch {
          // No human resolved the decision in time — expire for later review.
          await step.do(`expire-${decisionId}`, () =>
            buildContainer(this.env).executionService.failRun(
              workspaceId,
              executionId,
              'Decision timed out awaiting a human response',
              'decision_timeout',
            ),
          )
          return
        }
      }
      // 'continue' or a resolved decision: loop and advance the next step.
    }
  }
}
