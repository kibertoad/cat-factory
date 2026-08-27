import {
  WorkflowEntrypoint,
  type WorkflowEvent,
  type WorkflowSleepDuration,
  type WorkflowStep,
  type WorkflowStepConfig,
} from 'cloudflare:workers'
import { getErrorMessage, type Logger, redactSecrets } from '@cat-factory/kernel'
import type { AdvanceResult, RunFailure } from '@cat-factory/orchestration'
import {
  failureFromAdvanceError,
  failureFromDriver,
  failureFromResult,
} from '@cat-factory/orchestration'
import type { Env } from '../env'
import { buildContainer } from '../container'
import { loadConfig } from '../config'
import { logger } from '../observability/logger'
import { withWorkflowLogExport } from './logExport'
import { buildWorkflowRuntime } from './runtime'
import type { ExecutionWorkflowParams } from './WorkflowsWorkRunner'

/**
 * Per-step retry policy: failures retry a few times before the run is failed. The timeout is the
 * engine's hang bound on one advance (`ExecutionConfig.advanceTimeout`) rather than a constant,
 * because Node races the SAME value in `driveExecution`: one knob, so the two facades cannot
 * drift apart on how long a wedged advance is waited out (stuck-run audit F9).
 */
function buildStepConfig(timeout: string): WorkflowStepConfig {
  return {
    retries: { limit: 3, delay: '5 seconds', backoff: 'exponential' },
    timeout: timeout as WorkflowStepConfig['timeout'],
  }
}

/** Outcome of one durable status read: a settled result, or a tolerated transient read error. */
type PollAttempt = { kind: 'ok'; result: AdvanceResult } | { kind: 'read_failed'; message: string }

/**
 * The bound callbacks and knobs one durable poll loop needs. The two loops below are lifted out of
 * {@link ExecutionWorkflow.run} — which owns the run-scoped closures they call — so that driver
 * stays within the per-function line budget; they take those closures as deps rather than
 * re-deriving anything, so the loops remain pure control flow with no business logic of their own.
 */
interface PollLoopDeps {
  step: WorkflowStep
  log: Pick<Logger, 'warn'>
  /** `execConfig.jobMaxPolls` / `ciMaxPolls` — the backstop bound on this loop's iterations. */
  maxPolls: number
  /** `execConfig.jobPollFailureTolerance` — consecutive unreadable polls before failing the run. */
  failureTolerance: number
  /** The durable sleep between polls. */
  pollInterval: WorkflowSleepDuration
  /** The per-durable-step retry/timeout policy (see {@link buildStepConfig}). */
  stepConfig: WorkflowStepConfig
  pollOnce: (label: string, read: () => Promise<AdvanceResult>) => Promise<PollAttempt>
  failRun: (i: number, failure: RunFailure) => Promise<void>
  /** One status read (`pollAgentJob` / `pollGate`), already bound to the run. */
  poll: () => Promise<AdvanceResult>
}

/**
 * Poll a dispatched async job (a container coding step) for step `i` between durable
 * sleeps until it finishes. A thrown poll error is always transient, so tolerate a
 * bounded run of them (reset on any good poll) and only fail the run once the tolerance
 * is spent or the budget runs out. Returns the settled result, or `null` once it has
 * already failed the run (the caller returns).
 */
async function drivePollLoop(
  deps: PollLoopDeps & {
    /** The park kind this loop drains; anything else settles it. Defaults to `awaiting_job`. */
    awaiting?: AdvanceResult['kind']
    /** What a spent budget FAILED at, e.g. "Implementation job". Defaults to that. */
    label?: string
    /**
     * Whether the FIRST read runs before any sleep. True for a just-dispatched job (a leading
     * interval would be dead air between "accepted" and the first progress reaching the board);
     * false where the advance that parked the step already made the same read moments ago.
     */
    pollFirst?: boolean
  },
  i: number,
  initial: AdvanceResult,
): Promise<AdvanceResult | null> {
  const { step, log, maxPolls, failureTolerance, pollInterval, pollOnce, failRun, poll } = deps
  const awaiting = deps.awaiting ?? 'awaiting_job'
  const label = deps.label ?? 'Implementation job'
  let result = initial
  let polled = false
  let pollReadFailures = 0
  for (let p = 0; p < maxPolls; p++) {
    // Poll-first: the job was dispatched instants ago by `advance-${i}`, so the first
    // status read runs immediately — a leading sleep would be a full poll interval of
    // dead air. Later iterations sleep between polls.
    if (p > 0 || deps.pollFirst === false) await step.sleep(`poll-wait-${i}-${p}`, pollInterval)
    const attempt = await pollOnce(`poll-${i}-${p}`, poll)
    if (attempt.kind === 'read_failed') {
      pollReadFailures += 1
      log.warn('poll could not read job status; treating as still running and retrying', {
        step: i,
        poll: p,
        pollReadFailures,
        err: attempt.message,
      })
      if (pollReadFailures < failureTolerance) continue
      await failRun(
        i,
        failureFromDriver(
          `Job status was unreadable for ${pollReadFailures} consecutive polls; ` +
            `the container appears unreachable (last error: ${attempt.message})`,
          'timeout',
        ),
      )
      return null
    }
    pollReadFailures = 0
    result = attempt.result
    if (result.kind !== awaiting) {
      polled = true
      break
    }
  }
  if (!polled && result.kind === awaiting) {
    await failRun(
      i,
      failureFromDriver(`${label} did not finish within its polling budget`, 'timeout'),
    )
    return null
  }
  return result
}

/**
 * Drive a polling gate (`ci` / `conflicts` / post-release-health) for step `i` between
 * durable sleeps until its precheck yields something terminal. A passing precheck
 * returns `continue`, a dispatched helper agent returns `awaiting_job`, and a spent
 * budget resolves through the gate's own exhaustion policy. Read failures are tolerated
 * exactly like the job loop. Returns the updated result, or `null` once it failed the run.
 */
async function driveGatePollLoop(
  deps: PollLoopDeps & { resolveExhaustion: () => Promise<AdvanceResult> },
  i: number,
  initial: AdvanceResult,
): Promise<AdvanceResult | null> {
  const { step, log, maxPolls, failureTolerance, pollInterval, pollOnce, failRun, poll } = deps
  let result = initial
  let settled = false
  let pollReadFailures = 0
  for (let p = 0; p < maxPolls; p++) {
    await step.sleep(`gate-wait-${i}-${p}`, pollInterval)
    const attempt = await pollOnce(`gate-poll-${i}-${p}`, poll)
    if (attempt.kind === 'read_failed') {
      pollReadFailures += 1
      log.warn('gate poll could not read its precheck; treating as still pending and retrying', {
        step: i,
        poll: p,
        pollReadFailures,
        err: attempt.message,
      })
      if (pollReadFailures < failureTolerance) continue
      await failRun(
        i,
        failureFromDriver(
          `Gate precheck was unreadable for ${pollReadFailures} consecutive polls ` +
            `(last error: ${attempt.message})`,
          'timeout',
        ),
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
    result = (await step.do(
      `gate-exhausted-${i}`,
      deps.stepConfig,
      deps.resolveExhaustion,
    )) as AdvanceResult
  }
  return result
}

/**
 * Durable driver for one pipeline run. It contains NO business logic — every
 * decision lives in core's ExecutionService. Each loop iteration advances the
 * run by exactly one agent step inside a retriable, checkpointed `step.do`, then
 * either loops, parks on a human decision via `waitForEvent`, or stops. Because
 * each committed step is memoised, a crash and replay never re-issues an
 * already-completed LLM call.
 */
export class ExecutionWorkflow extends WorkflowEntrypoint<Env, ExecutionWorkflowParams> {
  override run(event: WorkflowEvent<ExecutionWorkflowParams>, step: WorkflowStep): Promise<void> {
    // The wake's logging bracket. It matters most HERE: this driver parks on `waitForEvent` for
    // as long as a human takes to answer, so the wake that dispatched a step and the wake that
    // settles it are different isolates, and only a drain in front of each suspension gets the
    // first one's lines out. See `./logExport.ts`.
    return withWorkflowLogExport(this.env, step, (step) => this.drive(event.payload, step))
  }

  private async drive(params: ExecutionWorkflowParams, step: WorkflowStep): Promise<void> {
    const { workspaceId, executionId } = params
    // Bind the run's correlation ONCE, the way `BootstrapWorkflow`/`EnvConfigRepairWorkflow`
    // already do and `driveExecution` does on the Node side. Re-spreading the ids per call is
    // how a nested emit ends up with none of them (observability-logging-gaps.md, A3).
    const log = logger.child({ workspaceId, executionId, workflow: 'execution' })
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
    const stepConfig = buildStepConfig(execConfig.advanceTimeout)
    // Chunk length for a spend-paused run's budget re-check (see the `paused` branch below).
    // Reuses the decision-wait cadence (default 24h), NOT the short gate-poll cadence: the run
    // parks on `waitForEvent`, so `/spend/resume` wakes it immediately via `signalResume` and
    // this timeout only backstops auto-resume on a new billing period. A long chunk keeps the
    // instance's durable step history bounded (≈1/day, like a decision wait) instead of the
    // thousands/day a 30s busy-loop would accrue toward the Workflows per-instance limit.
    const pauseRecheckTimeout = decisionTimeout

    // Takes the shared {@link RunFailure} rather than positional arguments of its own. The
    // positional form is how this driver silently dropped `AgentFailure.reason` on the DEPLOYED
    // runtime for every failure — the helper simply had no `reason` parameter while the
    // runtime-neutral `drive.ts` twin forwarded it, disabling the SPA's whole `AgentFailureCard`
    // remedy branch on Cloudflare only. Every parameter carried a default, so a call site that
    // stopped short read as deliberate. With one shape shared by both drivers, a dropped field
    // is a typecheck failure (observability-logging-gaps.md, B3).
    const failRun = async (i: number, failure: RunFailure): Promise<void> => {
      log.warn(`failing run: ${failure.message}`, {
        step: i,
        failureKind: failure.kind,
        ...(failure.reason ? { reason: failure.reason } : {}),
      })
      await step.do(`fail-${i}`, () =>
        container.executionService.failRun(
          workspaceId,
          executionId,
          failure.message,
          failure.kind,
          failure.detail,
          failure.reason,
        ),
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
        return { kind: 'ok', result: (await step.do(label, stepConfig, read)) as AdvanceResult }
      } catch (error) {
        // Scrubbed HERE, once, because this message is both logged and folded into the run's
        // user-visible failure text — and a poll error surfaced from `fetch` routinely echoes
        // the request URL (with its query) or an auth header back in its own message.
        const raw = getErrorMessage(error)
        return { kind: 'read_failed', message: redactSecrets(raw) ?? '' }
      }
    }

    // The two durable poll loops are module-level (see `drivePollLoop` / `driveGatePollLoop`),
    // taking the run-scoped closures above as bound deps so this driver stays within the
    // per-function line budget.
    const jobPollDeps: PollLoopDeps = {
      step,
      log,
      maxPolls: execConfig.jobMaxPolls,
      failureTolerance: execConfig.jobPollFailureTolerance,
      pollInterval: jobPollInterval,
      stepConfig,
      pollOnce,
      failRun,
      poll: () => container.executionService.pollAgentJob(workspaceId, executionId),
    }
    const gatePollDeps = {
      ...jobPollDeps,
      maxPolls: execConfig.ciMaxPolls,
      pollInterval: ciPollInterval,
      poll: () => container.executionService.pollGate(workspaceId, executionId),
      resolveExhaustion: () =>
        container.executionService.resolveGatePollExhaustion(workspaceId, executionId),
    }

    for (let i = 0; ; i++) {
      let result: AdvanceResult
      try {
        result = (await step.do(`advance-${i}`, stepConfig, () =>
          container.executionService.advanceInstance(workspaceId, executionId, {
            rethrowAgentErrors: true,
          }),
        )) as AdvanceResult
      } catch (error) {
        // Retries exhausted: persist the failure and open the block for review. A thrown
        // `DomainError` carries its machine-readable `details.reason` (e.g. a
        // `providers_unconfigured` conflict), which is exactly the class of failure the SPA
        // has a remedy for — `getErrorReason` is the read-side dual that lifts it onto the
        // run rather than leaving the user with prose to string-match.
        await failRun(i, failureFromAdvanceError(error))
        return
      }

      // An async step (a container coding job) dispatched and parked. Poll it between
      // durable sleeps until it finishes — each poll is its own short, retriable step, so
      // the job can run far longer than one step's timeout while the driver stays cheap and
      // survives eviction. The job's bound is enforced container-side (inactivity +
      // max-duration watchdogs); `jobMaxPolls` is only a backstop. `null` means the loop
      // already failed the run.
      // A `deployer` step is waiting for the environment it provisioned to become ready.
      // Re-read the provider between durable sleeps on the JOB cadence (infra coming up, not a
      // human-scale gate), through the same `pollAgentJob` entry point. Handled BEFORE the job
      // branch so a ready environment that dispatches the next frame's deploy job falls straight
      // into it. The wait's own ceiling settles it long before this budget does.
      if (result.kind === 'awaiting_environment') {
        const waited = await drivePollLoop(
          {
            ...jobPollDeps,
            awaiting: 'awaiting_environment',
            label: 'Environment readiness',
            // Sleep-first, matching `drive.ts`: the advance that parked the step read the
            // provider moments ago.
            pollFirst: false,
          },
          i,
          result,
        )
        if (waited === null) return
        result = waited
      }

      if (result.kind === 'awaiting_job') {
        const polledResult = await drivePollLoop(jobPollDeps, i, result)
        if (polledResult === null) return
        result = polledResult
      }

      // A polling gate step (`ci` / `conflicts` / post-release-health) is gating the PR on
      // its precheck. Re-run the precheck between durable sleeps until the gate yields
      // something terminal (see `driveGatePollLoop`). One loop drives every gate kind, since
      // which gate is resolved inside `pollGate` from the current step.
      if (result.kind === 'awaiting_gate') {
        const gatedResult = await driveGatePollLoop(gatePollDeps, i, result)
        if (gatedResult === null) return
        result = gatedResult
        // Fall through: the now-updated `result` (continue / done / awaiting_job /
        // job_failed) is handled by the checks below and the next outer-loop iteration.
      }

      if (result.kind === 'job_failed') {
        // An inline gate may carry the precise classification + diagnostic (e.g. an
        // unparseable companion verdict → `companion_rejected` with its raw reply as
        // detail); record those instead of the generic container-failure framing.
        await failRun(i, failureFromResult(result))
        return
      }

      // The container kept getting evicted/crashing even after the engine's single
      // automatic fresh-container restart, so the eviction is deterministic: fail
      // the run as `evicted` (its hint points at the container logs / instance size).
      if (result.kind === 'job_evicted') {
        // Record the transport's container post-mortem as the failure detail, as `drive.ts`
        // does — the container is already reclaimed, so this is the only surviving account
        // of why it died. Dropping it here made an eviction unfalsifiable on the runtime
        // where containers actually run.
        await failRun(i, failureFromResult(result))
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
