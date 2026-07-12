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

    // Consecutive failures to READ/advance the run — treated as transient (retried within the
    // budget rather than failing the run on a blip). See BootstrapWorkflow (F2): returning on a
    // transient throw would make the instance terminal prematurely. Only a genuine terminal state
    // returns early; exhausting the whole budget finalizes the run via `finalizeExhausted` below
    // (these runs have no separate stuck-run sweeper, unlike the agent_runs-backed flows).
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
    // Budget exhausted without converging. There is no stuck-run sweeper for this table, so
    // finalize here (best-effort cleanup + mark failed) rather than leaving the run `running`
    // forever with an orphaned branch/env.
    log.warn('env-test run exhausted its polling budget; finalizing (cleanup + fail)')
    try {
      await step.do('finalize-exhausted', STEP_CONFIG, async () => {
        const service = container.environments?.environmentTest
        await service?.finalizeExhausted(workspaceId, jobId)
      })
    } catch (error) {
      log.warn(
        { err: error instanceof Error ? error.message : String(error) },
        'env-test finalize-exhausted failed; run left for a later re-drive',
      )
    }
  }
}
