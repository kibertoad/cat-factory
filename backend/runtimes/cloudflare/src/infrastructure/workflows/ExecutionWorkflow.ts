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
import { buildWorkflowRuntime } from './runtime'
import type { ExecutionWorkflowParams } from './WorkflowsWorkRunner'

/** Per-step retry policy: failures retry a few times before the run is failed. */
const STEP_CONFIG = {
  retries: { limit: 3, delay: '5 seconds', backoff: 'exponential' },
  timeout: '5 minutes',
} satisfies WorkflowStepConfig

/** Outcome of one durable status read: a settled result, or a tolerated transient read error. */
type PollAttempt = { kind: 'ok'; result: AdvanceResult } | { kind: 'read_failed'; message: string }

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
    // One DI-graph assembly per wake: the container is pure wiring over env bindings
    // (no I/O), so every step/poll in this invocation shares it instead of re-running
    // the whole composition root per `step.do`. A hibernation wake replays `run()`
    // from the top, so each wake still gets a fresh build. Built via `buildWorkflowRuntime`
    // so a transient throw here can't kill a parked (`blocked`) instance terminally and
    // discard the human's decision (F5).
    const { container, execConfig } = await buildWorkflowRuntime(
      () => ({ container: buildContainer(this.env), execConfig: loadConfig(this.env).execution }),
      step,
      'exec',
    )
    const decisionTimeout = execConfig.decisionTimeout as WorkflowSleepDuration
    const jobPollInterval = execConfig.jobPollInterval as WorkflowSleepDuration
    const ciPollInterval = execConfig.ciPollInterval as WorkflowSleepDuration
    // Chunk length for a spend-paused run's budget re-check (see the `paused` branch below).
    // Reuses the decision-wait cadence (default 24h), NOT the short gate-poll cadence: the run
    // parks on `waitForEvent`, so `/spend/resume` wakes it immediately via `signalResume` and
    // this timeout only backstops auto-resume on a new billing period. A long chunk keeps the
    // instance's durable step history bounded (≈1/day, like a decision wait) instead of the
    // thousands/day a 30s busy-loop would accrue toward the Workflows per-instance limit.
    const pauseRecheckTimeout = decisionTimeout

    const failRun = async (
      i: number,
      message: string,
      kind: AgentFailureKind = 'agent',
      detail: string | null = null,
    ): Promise<void> => {
      logger.warn({ workspaceId, executionId, step: i }, `failing run: ${message}`)
      await step.do(`fail-${i}`, () =>
        container.executionService.failRun(workspaceId, executionId, message, kind, detail),
      )
    }

    // Run one durable status read, converting a *thrown* (transient) poll error into a
    // `read_failed` value the caller tolerates rather than a failure that kills the run.
    // Eviction / a genuine job failure are RETURNED as an `ok` AdvanceResult, not thrown.
    const pollOnce = async (
      label: string,
      read: () => Promise<AdvanceResult>,
    ): Promise<PollAttempt> => {
      try {
        return { kind: 'ok', result: (await step.do(label, STEP_CONFIG, read)) as AdvanceResult }
      } catch (error) {
        return {
          kind: 'read_failed',
          message: error instanceof Error ? error.message : String(error),
        }
      }
    }

    // Poll a dispatched async job (a container coding step) for step `i` between durable
    // sleeps until it finishes. A thrown poll error is always transient, so tolerate a
    // bounded run of them (reset on any good poll) and only fail the run once the tolerance
    // is spent or the budget runs out. Returns the settled result, or `null` once it has
    // already failed the run (the caller returns).
    const drivePollLoop = async (
      i: number,
      initial: AdvanceResult,
    ): Promise<AdvanceResult | null> => {
      let result = initial
      let polled = false
      let pollReadFailures = 0
      for (let p = 0; p < execConfig.jobMaxPolls; p++) {
        // Poll-first: the job was dispatched instants ago by `advance-${i}`, so the first
        // status read runs immediately — a leading sleep would be a full poll interval of
        // dead air. Later iterations sleep between polls.
        if (p > 0) await step.sleep(`poll-wait-${i}-${p}`, jobPollInterval)
        const attempt = await pollOnce(`poll-${i}-${p}`, () =>
          container.executionService.pollAgentJob(workspaceId, executionId),
        )
        if (attempt.kind === 'read_failed') {
          pollReadFailures += 1
          logger.warn(
            { workspaceId, executionId, step: i, poll: p, pollReadFailures, err: attempt.message },
            'poll could not read job status; treating as still running and retrying',
          )
          if (pollReadFailures < execConfig.jobPollFailureTolerance) continue
          await failRun(
            i,
            `Job status was unreadable for ${pollReadFailures} consecutive polls; ` +
              `the container appears unreachable (last error: ${attempt.message})`,
            'timeout',
          )
          return null
        }
        pollReadFailures = 0
        result = attempt.result
        if (result.kind !== 'awaiting_job') {
          polled = true
          break
        }
      }
      if (!polled && result.kind === 'awaiting_job') {
        await failRun(i, 'Implementation job did not finish within its polling budget', 'timeout')
        return null
      }
      return result
    }

    // Drive a polling gate (`ci` / `conflicts` / post-release-health) for step `i` between
    // durable sleeps until its precheck yields something terminal. A passing precheck
    // returns `continue`, a dispatched helper agent returns `awaiting_job`, and a spent
    // budget resolves through the gate's own exhaustion policy. Read failures are tolerated
    // exactly like the job loop. Returns the updated result, or `null` once it failed the run.
    const driveGatePollLoop = async (
      i: number,
      initial: AdvanceResult,
    ): Promise<AdvanceResult | null> => {
      let result = initial
      let settled = false
      let pollReadFailures = 0
      for (let p = 0; p < execConfig.ciMaxPolls; p++) {
        await step.sleep(`gate-wait-${i}-${p}`, ciPollInterval)
        const attempt = await pollOnce(`gate-poll-${i}-${p}`, () =>
          container.executionService.pollGate(workspaceId, executionId),
        )
        if (attempt.kind === 'read_failed') {
          pollReadFailures += 1
          logger.warn(
            { workspaceId, executionId, step: i, poll: p, pollReadFailures, err: attempt.message },
            'gate poll could not read its precheck; treating as still pending and retrying',
          )
          if (pollReadFailures < execConfig.jobPollFailureTolerance) continue
          await failRun(
            i,
            `Gate precheck was unreadable for ${pollReadFailures} consecutive polls ` +
              `(last error: ${attempt.message})`,
            'timeout',
          )
          return null
        }
        pollReadFailures = 0
        result = attempt.result
        if (result.kind !== 'awaiting_gate') {
          settled = true
          break
        }
      }
      if (!settled && result.kind === 'awaiting_gate') {
        // Poll budget spent. Let the gate decide: a time-windowed watch gate
        // (post-release-health) PASSES, while CI/conflicts resolve to a `job_failed`
        // timeout the checks below funnel through `failRun`. One policy, both runtimes.
        result = (await step.do(`gate-exhausted-${i}`, STEP_CONFIG, () =>
          container.executionService.resolveGatePollExhaustion(workspaceId, executionId),
        )) as AdvanceResult
      }
      return result
    }

    for (let i = 0; ; i++) {
      let result: AdvanceResult
      try {
        result = (await step.do(`advance-${i}`, STEP_CONFIG, () =>
          container.executionService.advanceInstance(workspaceId, executionId, {
            rethrowAgentErrors: true,
          }),
        )) as AdvanceResult
      } catch (error) {
        // Retries exhausted: persist the failure and open the block for review.
        await failRun(i, error instanceof Error ? error.message : String(error))
        return
      }

      // An async step (a container coding job) dispatched and parked. Poll it between
      // durable sleeps until it finishes — each poll is its own short, retriable step, so
      // the job can run far longer than one step's timeout while the driver stays cheap and
      // survives eviction. The job's bound is enforced container-side (inactivity +
      // max-duration watchdogs); `jobMaxPolls` is only a backstop. `null` means the loop
      // already failed the run.
      if (result.kind === 'awaiting_job') {
        const polledResult = await drivePollLoop(i, result)
        if (polledResult === null) return
        result = polledResult
      }

      // A polling gate step (`ci` / `conflicts` / post-release-health) is gating the PR on
      // its precheck. Re-run the precheck between durable sleeps until the gate yields
      // something terminal (see `driveGatePollLoop`). One loop drives every gate kind, since
      // which gate is resolved inside `pollGate` from the current step.
      if (result.kind === 'awaiting_gate') {
        const gatedResult = await driveGatePollLoop(i, result)
        if (gatedResult === null) return
        result = gatedResult
        // Fall through: the now-updated `result` (continue / done / awaiting_job /
        // job_failed) is handled by the checks below and the next outer-loop iteration.
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

      if (result.kind === 'done' || result.kind === 'noop') return

      // 'paused' means the spend budget is exhausted. Do NOT return: returning makes this
      // Workflows instance TERMINAL, and a terminal instance id can never be re-created (see
      // WorkflowsLookup) — so `/spend/resume`'s `create` would silently no-op and the cron
      // sweeper would later force-fail the "resumed" run. Instead we keep the instance ALIVE
      // parked on `waitForEvent`, EXACTLY like a decision wait (not a busy sleep-loop): a
      // `spend-resume` event from `resumePaused`'s `signalResume` wakes it immediately, and on
      // the timeout we simply re-loop and re-advance from storage — auto-resuming when the
      // budget frees up on a new billing period. Parking (vs a short durable sleep) keeps the
      // step history bounded over a pause that can last days/weeks. The per-iteration `-${i}`
      // keeps each re-armed wait a distinct step.
      if (result.kind === 'paused') {
        try {
          await step.waitForEvent(`spend-resume-${i}`, {
            type: 'spend-resume',
            timeout: pauseRecheckTimeout,
          })
        } catch {
          // Timed out without a resume signal — fall through and re-loop to re-check the budget.
        }
        continue
      }

      if (result.kind === 'awaiting_decision') {
        const decisionId = result.decisionId
        // A parked run waits for a human INDEFINITELY — the old hard "decision timeout"
        // that failed the run is gone (a run can legitimately sit waiting for input for
        // as long as it takes; urgency is surfaced by the notification escalating
        // yellow → red, not by killing the run). Cloudflare's `waitForEvent` still needs
        // a finite timeout, so we wait in chunks: on expiry we simply re-loop, which
        // re-advances the run from storage — resuming if the decision was resolved while
        // we weren't listening (self-healing a missed signal), or re-arming the wait
        // otherwise. The per-iteration `-${i}` keeps each re-armed wait a distinct step.
        try {
          await step.waitForEvent(`await-${decisionId}-${i}`, {
            type: `decision-${decisionId}`,
            timeout: decisionTimeout,
          })
        } catch {
          // Timed out without a signal — fall through and re-loop (do NOT fail the run).
        }
      }
      // 'continue', a resolved decision, or a re-armed wait: loop and advance again.
    }
  }
}
