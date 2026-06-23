import {
  WorkflowEntrypoint,
  type WorkflowEvent,
  type WorkflowSleepDuration,
  type WorkflowStep,
  type WorkflowStepConfig,
} from 'cloudflare:workers'
import type { AgentFailureKind } from '@cat-factory/kernel'
import type { AdvanceResult } from '@cat-factory/orchestration'
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
    const ciPollInterval = execConfig.ciPollInterval as WorkflowSleepDuration

    const failRun = async (
      i: number,
      message: string,
      kind: AgentFailureKind = 'agent',
      detail: string | null = null,
    ): Promise<void> => {
      logger.warn({ workspaceId, executionId, step: i }, `failing run: ${message}`)
      await step.do(`fail-${i}`, () =>
        buildContainer(this.env).executionService.failRun(
          workspaceId,
          executionId,
          message,
          kind,
          detail,
        ),
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

      // A `ci` step is gating the PR on green CI. Poll GitHub check runs between
      // durable sleeps — mirroring the job-poll loop above — until the gate yields
      // something terminal: green CI returns `continue`, a dispatched CI-fixer
      // returns `awaiting_job` (handled on the next outer-loop iteration), and a
      // spent budget returns `job_failed`. Each poll is its own short, retriable
      // step so the gate can wait far longer than one step's timeout while the
      // driver stays cheap and survives eviction.
      if (result.kind === 'awaiting_ci') {
        let settled = false
        let pollReadFailures = 0
        for (let p = 0; p < execConfig.ciMaxPolls; p++) {
          await step.sleep(`ci-wait-${i}-${p}`, ciPollInterval)
          try {
            result = (await step.do(`ci-poll-${i}-${p}`, STEP_CONFIG, () =>
              buildContainer(this.env).executionService.pollCi(workspaceId, executionId),
            )) as AdvanceResult
          } catch (error) {
            pollReadFailures += 1
            const message = error instanceof Error ? error.message : String(error)
            logger.warn(
              { workspaceId, executionId, step: i, poll: p, pollReadFailures, err: message },
              'CI poll could not read status; treating as still pending and retrying',
            )
            if (pollReadFailures >= execConfig.jobPollFailureTolerance) {
              await failRun(
                i,
                `CI status was unreadable for ${pollReadFailures} consecutive polls (last error: ${message})`,
                'timeout',
              )
              return
            }
            continue
          }
          pollReadFailures = 0
          if (result.kind !== 'awaiting_ci') {
            settled = true
            break
          }
        }
        if (!settled && result.kind === 'awaiting_ci') {
          await failRun(i, 'CI did not settle within its polling budget', 'timeout')
          return
        }
        // Fall through: the now-updated `result` (continue / awaiting_job / job_failed)
        // is handled by the checks below and the next outer-loop iteration.
      }

      // A `conflicts` step is gating the PR on being mergeable. Poll mergeability
      // between durable sleeps — mirroring the CI loop above, reusing the CI poll
      // cadence — until the gate yields something terminal: a mergeable PR returns
      // `continue`, a dispatched conflict-resolver returns `awaiting_job` (handled on
      // the next outer-loop iteration), and a spent budget returns `job_failed`.
      if (result.kind === 'awaiting_conflicts') {
        let settled = false
        let pollReadFailures = 0
        for (let p = 0; p < execConfig.ciMaxPolls; p++) {
          await step.sleep(`conflicts-wait-${i}-${p}`, ciPollInterval)
          try {
            result = (await step.do(`conflicts-poll-${i}-${p}`, STEP_CONFIG, () =>
              buildContainer(this.env).executionService.pollConflicts(workspaceId, executionId),
            )) as AdvanceResult
          } catch (error) {
            pollReadFailures += 1
            const message = error instanceof Error ? error.message : String(error)
            logger.warn(
              { workspaceId, executionId, step: i, poll: p, pollReadFailures, err: message },
              'conflict poll could not read mergeability; treating as still pending and retrying',
            )
            if (pollReadFailures >= execConfig.jobPollFailureTolerance) {
              await failRun(
                i,
                `PR mergeability was unreadable for ${pollReadFailures} consecutive polls (last error: ${message})`,
                'timeout',
              )
              return
            }
            continue
          }
          pollReadFailures = 0
          if (result.kind !== 'awaiting_conflicts') {
            settled = true
            break
          }
        }
        if (!settled && result.kind === 'awaiting_conflicts') {
          await failRun(i, 'PR mergeability did not settle within its polling budget', 'timeout')
          return
        }
        // Fall through: the now-updated `result` is handled below / next iteration.
      }

      if (result.kind === 'job_failed') {
        // An inline gate may carry the precise classification + diagnostic (e.g. an
        // unparseable companion verdict → `companion_rejected` with its raw reply as
        // detail); record those instead of the generic container-failure framing.
        await failRun(i, result.error, result.failureKind ?? 'job_failed', result.detail ?? null)
        return
      }

      // The container kept getting evicted/crashing even after the engine's single
      // automatic fresh-container restart, so the eviction is deterministic: fail
      // the run as `evicted` (its hint points at the container logs / instance size).
      if (result.kind === 'job_evicted') {
        await failRun(i, result.error, 'evicted')
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
