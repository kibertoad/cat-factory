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
        // Retries exhausted: the poll itself is failing (not the bootstrap). Leave
        // the job `running`; the cron sweep can re-drive it. Stop this instance.
        log.error(
          { err: error instanceof Error ? error.message : String(error) },
          'bootstrap poll step failed after retries',
        )
        return
      }
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
