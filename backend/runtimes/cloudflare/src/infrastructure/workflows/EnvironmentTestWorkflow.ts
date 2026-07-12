import {
  WorkflowEntrypoint,
  type WorkflowEvent,
  type WorkflowSleepDuration,
  type WorkflowStep,
  type WorkflowStepConfig,
} from 'cloudflare:workers'
import type { EnvironmentTestPollResult } from '@cat-factory/orchestration'
import type { Env } from '../env'
import { buildContainer } from '../container'
import { loadConfig } from '../config'
import { logger } from '../observability/logger'
import { buildWorkflowRuntime } from './runtime'

/** Params passed to an EnvironmentTestWorkflow instance (its id is the self-test run id). */
export interface EnvironmentTestWorkflowParams {
  workspaceId: string
  jobId: string
}

/** Per-step retry policy: a transient poll failure retries before the run fails. */
const STEP_CONFIG = {
  retries: { limit: 3, delay: '5 seconds', backoff: 'exponential' },
  timeout: '2 minutes',
} satisfies WorkflowStepConfig

/**
 * Durable driver for one ephemeral-environment self-test run, mirroring
 * EnvConfigRepairWorkflow / BootstrapWorkflow. It holds NO business logic — every stage
 * transition lives in core's EnvironmentTestService. Each iteration advances the run's
 * state machine by one step (poll provisioning / tear down / delete branch) inside a
 * retriable, checkpointed `step.do` and sleeps durably between polls, so a long
 * provisioning survives eviction while the driver stays cheap.
 */
export class EnvironmentTestWorkflow extends WorkflowEntrypoint<
  Env,
  EnvironmentTestWorkflowParams
> {
  override async run(
    event: WorkflowEvent<EnvironmentTestWorkflowParams>,
    step: WorkflowStep,
  ): Promise<void> {
    const { workspaceId, jobId } = event.payload
    const { container, execConfig } = await buildWorkflowRuntime(
      () => ({ container: buildContainer(this.env), execConfig: loadConfig(this.env).execution }),
      step,
      'env-test',
    )
    const pollInterval = execConfig.jobPollInterval as WorkflowSleepDuration
    const log = logger.child({ workspaceId, jobId, workflow: 'env-test' })

    // Consecutive failures to READ/advance the run — treated as transient. See
    // BootstrapWorkflow (F2): returning on a transient throw would make the instance terminal
    // and get the still-`running` run finalized as STOPPED by the sweeper instead of resumed.
    let pollReadFailures = 0
    for (let p = 0; p < execConfig.jobMaxPolls; p++) {
      await step.sleep(`poll-wait-${p}`, pollInterval)
      let result: EnvironmentTestPollResult
      try {
        result = (await step.do(`poll-${p}`, STEP_CONFIG, async () => {
          const service = container.environments?.environmentTest
          if (!service) {
            throw new Error('Environment test module is not configured')
          }
          return service.pollEnvTest(workspaceId, jobId)
        })) as EnvironmentTestPollResult
      } catch (error) {
        pollReadFailures += 1
        log.warn(
          { err: error instanceof Error ? error.message : String(error), pollReadFailures },
          'env-test poll could not advance the run; treating as still running and retrying',
        )
        continue
      }
      pollReadFailures = 0
      if (result.state === 'done') {
        log.info('env-test run succeeded')
        return
      }
      if (result.state === 'failed') {
        log.warn({ error: result.error }, 'env-test run failed')
        return
      }
      // still running — loop and advance again after the next durable sleep.
    }
    log.warn('env-test run did not finish within its polling budget; finalizing via sweeper')
  }
}
