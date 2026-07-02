import {
  WorkflowEntrypoint,
  type WorkflowEvent,
  type WorkflowSleepDuration,
  type WorkflowStep,
  type WorkflowStepConfig,
} from 'cloudflare:workers'
import type { EnvConfigRepairPollResult } from '@cat-factory/orchestration'
import type { Env } from '../env'
import { buildContainer } from '../container'
import { loadConfig } from '../config'
import { logger } from '../observability/logger'
import { buildWorkflowRuntime } from './runtime'

/** Params passed to an EnvConfigRepairWorkflow instance (its id is the repair job id). */
export interface EnvConfigRepairWorkflowParams {
  workspaceId: string
  jobId: string
}

/** Per-step retry policy: a transient poll failure retries before the run fails. */
const STEP_CONFIG = {
  retries: { limit: 3, delay: '5 seconds', backoff: 'exponential' },
  timeout: '2 minutes',
} satisfies WorkflowStepConfig

/**
 * Durable driver for one environment-provider config-repair run, mirroring
 * BootstrapWorkflow. It holds NO business logic — every decision lives in core's
 * EnvConfigRepairService. Each iteration polls the repair container once inside a
 * retriable, checkpointed `step.do` and sleeps durably between polls, so the long
 * container run survives eviction while the driver stays cheap. The poll itself
 * persists subtask progress, re-validates the repo on success, and finalises the run
 * on a terminal outcome; this loop only decides when to stop.
 */
export class EnvConfigRepairWorkflow extends WorkflowEntrypoint<
  Env,
  EnvConfigRepairWorkflowParams
> {
  override async run(
    event: WorkflowEvent<EnvConfigRepairWorkflowParams>,
    step: WorkflowStep,
  ): Promise<void> {
    const { workspaceId, jobId } = event.payload
    // One DI-graph assembly per wake (pure wiring over env bindings, no I/O) shared by
    // every poll in this invocation; a hibernation wake replays `run()` and rebuilds. Built
    // via `buildWorkflowRuntime` so a transient throw here can't kill the instance terminally
    // (see F5/F2).
    const { container, execConfig } = await buildWorkflowRuntime(
      () => ({ container: buildContainer(this.env), execConfig: loadConfig(this.env).execution }),
      step,
      'repair',
    )
    const pollInterval = execConfig.jobPollInterval as WorkflowSleepDuration
    const log = logger.child({ workspaceId, jobId, workflow: 'env-config-repair' })

    // Consecutive failures to READ status — not the repair failing. See BootstrapWorkflow
    // for the rationale: a thrown poll error is always transient (a vanished container
    // surfaces as a 404→failed value), so keep polling through them rather than abandoning a
    // healthy run.
    let pollReadFailures = 0
    for (let p = 0; p < execConfig.jobMaxPolls; p++) {
      await step.sleep(`poll-wait-${p}`, pollInterval)
      let result: EnvConfigRepairPollResult
      try {
        result = (await step.do(`poll-${p}`, STEP_CONFIG, async () => {
          if (!container.envConfigRepair) {
            throw new Error('Env config repair module is not configured')
          }
          return container.envConfigRepair.service.pollJob(workspaceId, jobId)
        })) as EnvConfigRepairPollResult
      } catch (error) {
        pollReadFailures += 1
        log.warn(
          { err: error instanceof Error ? error.message : String(error), pollReadFailures },
          'env-config-repair poll could not read job status; treating as still running and retrying',
        )
        // Keep the instance ALIVE and keep polling — see BootstrapWorkflow (F2): returning on a
        // transient read failure would make the instance terminal and get the still-`running`
        // job finalized as STOPPED by the sweeper instead of resumed. A vanished container
        // surfaces as a 404→`failed` poll result below, not a throw; `pollReadFailures` is now
        // purely diagnostic.
        continue
      }
      pollReadFailures = 0
      if (result.state === 'done') {
        log.info('env-config-repair run succeeded')
        return
      }
      if (result.state === 'failed') {
        log.warn({ error: result.error }, 'env-config-repair run failed')
        return
      }
      // still running — loop and poll again after the next durable sleep.
    }
    // Poll budget spent (container is dead past its watchdog); the sweeper finalizes the
    // orphaned `running` job — the correct terminal outcome for a truly-wedged run.
    log.warn(
      'env-config-repair run did not finish within its polling budget; finalizing via sweeper',
    )
  }
}
