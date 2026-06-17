import {
  WorkflowEntrypoint,
  type WorkflowEvent,
  type WorkflowSleepDuration,
  type WorkflowStep,
  type WorkflowStepConfig,
} from 'cloudflare:workers'
import type { BootstrapPollResult } from '@cat-factory/core'
import type { Env } from '../env'
import { buildContainer } from '../container'
import { loadConfig } from '../config'
import { logger } from '../observability/logger'

/** Params passed to a BootstrapWorkflow instance (its id is the bootstrap job id). */
export interface BootstrapWorkflowParams {
  workspaceId: string
  jobId: string
}

/** Per-step retry policy: a transient poll failure retries before the run fails. */
const STEP_CONFIG = {
  retries: { limit: 3, delay: '5 seconds', backoff: 'exponential' },
  timeout: '2 minutes',
} satisfies WorkflowStepConfig

/**
 * Durable driver for one "bootstrap repo" run, mirroring ExecutionWorkflow. It
 * holds NO business logic — every decision lives in core's BootstrapService. Each
 * iteration polls the bootstrap container once inside a retriable, checkpointed
 * `step.do` and sleeps durably between polls, so the long container run survives
 * eviction while the driver stays cheap. The poll itself persists subtask progress
 * and finalises the board frame on a terminal outcome; this loop only decides when
 * to stop. The container's own inactivity + max-duration watchdogs bound the work;
 * `jobMaxPolls` is a backstop in case it never reports terminal.
 */
export class BootstrapWorkflow extends WorkflowEntrypoint<Env, BootstrapWorkflowParams> {
  override async run(
    event: WorkflowEvent<BootstrapWorkflowParams>,
    step: WorkflowStep,
  ): Promise<void> {
    const { workspaceId, jobId } = event.payload
    const execConfig = loadConfig(this.env).execution
    const pollInterval = execConfig.jobPollInterval as WorkflowSleepDuration
    const log = logger.child({ workspaceId, jobId, workflow: 'bootstrap' })

    // Consecutive failures to READ status — not the bootstrap failing. The agent
    // can briefly make the container unresponsive while busy (cloning, installing,
    // building); the job's real liveness is bounded container-side (inactivity +
    // max-duration watchdogs), and a vanished container surfaces as a 404→failed
    // value, so a *thrown* poll error is always transient. Tolerate a bounded run
    // of them (reset on any good poll) rather than abandoning a healthy run on the
    // first blip.
    let pollReadFailures = 0
    for (let p = 0; p < execConfig.jobMaxPolls; p++) {
      await step.sleep(`poll-wait-${p}`, pollInterval)
      let result: BootstrapPollResult
      try {
        result = (await step.do(`poll-${p}`, STEP_CONFIG, async () => {
          const container = buildContainer(this.env)
          if (!container.bootstrap) {
            throw new Error('Bootstrap module is not configured')
          }
          return container.bootstrap.service.pollBootstrapJob(workspaceId, jobId)
        })) as BootstrapPollResult
      } catch (error) {
        pollReadFailures += 1
        log.warn(
          { err: error instanceof Error ? error.message : String(error), pollReadFailures },
          'bootstrap poll could not read job status; treating as still running and retrying',
        )
        // Sustained unreachability: leave the job `running` so the cron sweep can
        // re-drive it later (the container may recover, or report terminal, by then).
        // Stop this instance to avoid burning the whole poll budget while wedged.
        if (pollReadFailures >= execConfig.jobPollFailureTolerance) {
          log.error('bootstrap poll unreadable past tolerance; leaving for sweeper')
          return
        }
        continue
      }
      pollReadFailures = 0
      if (result.state === 'done') {
        log.info('bootstrap run succeeded')
        return
      }
      if (result.state === 'failed') {
        log.warn({ error: result.error }, 'bootstrap run failed')
        return
      }
      // still running — loop and poll again after the next durable sleep.
    }
    log.warn('bootstrap run did not finish within its polling budget')
  }
}
