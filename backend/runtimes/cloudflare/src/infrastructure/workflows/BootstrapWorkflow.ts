import {
  WorkflowEntrypoint,
  type WorkflowEvent,
  type WorkflowSleepDuration,
  type WorkflowStep,
  type WorkflowStepConfig,
} from 'cloudflare:workers'
import type { BootstrapPollResult } from '@cat-factory/orchestration'
import type { Env } from '../env'
import { buildContainer } from '../container'
import { loadConfig } from '../config'
import { logger } from '../observability/logger'
import { buildWorkflowRuntime } from './runtime'

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
    // One DI-graph assembly per wake (pure wiring over env bindings, no I/O) shared by
    // every poll in this invocation; a hibernation wake replays `run()` and rebuilds. Built
    // via `buildWorkflowRuntime` so a transient throw here can't kill the instance terminally
    // (which the sweeper would then finalize as a STOPPED job — see F5/F2).
    const { container, execConfig } = await buildWorkflowRuntime(
      () => ({ container: buildContainer(this.env), execConfig: loadConfig(this.env).execution }),
      step,
      'bootstrap',
    )
    const pollInterval = execConfig.jobPollInterval as WorkflowSleepDuration
    const log = logger.child({ workspaceId, jobId, workflow: 'bootstrap' })

    // Consecutive failures to READ status — not the bootstrap failing. The agent
    // can briefly make the container unresponsive while busy (cloning, installing,
    // building); the job's real liveness is bounded container-side (inactivity +
    // max-duration watchdogs), and a vanished container surfaces as a 404→failed
    // value, so a *thrown* poll error is always transient. Keep polling through them
    // (reset the counter on any good poll) rather than abandoning a healthy run.
    let pollReadFailures = 0
    for (let p = 0; p < execConfig.jobMaxPolls; p++) {
      // Poll-first (matching the Node bootstrapRunner): the job was just dispatched, so
      // the first status read runs immediately instead of after a full poll interval.
      if (p > 0) await step.sleep(`poll-wait-${p}`, pollInterval)
      let result: BootstrapPollResult
      try {
        result = (await step.do(`poll-${p}`, STEP_CONFIG, async () => {
          if (!container.bootstrap) {
            throw new Error('Bootstrap module is not configured')
          }
          return container.bootstrap.service.pollBootstrapJob(workspaceId, jobId)
        })) as BootstrapPollResult
      } catch (error) {
        // Do NOT return on a thrown poll. Returning makes this Workflows instance TERMINAL, and
        // the cron sweep can't re-drive a terminal instance (its id can't be recreated) — it
        // takes the `finalizeOrphan` branch and STOPS the job, force-failing a bootstrap that was
        // merely busy (a long clone/install) instead of recovering it. So we keep the instance
        // alive and keep polling with the durable sleep between attempts (cheap, survives
        // eviction): the container's own inactivity + max-duration watchdogs bound the work, a
        // vanished container surfaces as a 404→`failed` RESULT (handled below, not a throw), and
        // `jobMaxPolls` is the sole backstop for a container that never reports terminal.
        //
        // `pollReadFailures` is therefore diagnostic ONLY (how long we've been blind) — it drives
        // no control flow here, unlike the ExecutionWorkflow job/gate loops where a thrown poll
        // past `jobPollFailureTolerance` fails the run. A bootstrap has no cheap way to tell a
        // half-alive-but-busy container from a dead one, so we favour recovery and let the poll
        // budget + container watchdogs (not a throw-count) decide the end.
        pollReadFailures += 1
        log.warn(
          { err: error instanceof Error ? error.message : String(error), pollReadFailures },
          'bootstrap poll could not read job status; treating as still running and retrying',
        )
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
    // Poll budget spent. By now the container is long past its own max-duration watchdog, so a
    // healthy-and-progressing run cannot legitimately reach here — the container is dead and its
    // last poll never reported terminal. Returning makes the instance terminal; the sweeper then
    // finalizes the orphaned `running` job (the correct terminal outcome for a truly-wedged run).
    log.warn('bootstrap run did not finish within its polling budget; finalizing via sweeper')
  }
}
