import { describeError, noopLogger, type Logger } from '@cat-factory/kernel'
import type { AdvanceResult } from './advance.js'
import {
  failureFromAdvanceError,
  failureFromDriver,
  failureFromResult,
  type RunFailure,
} from './runFailure.js'
import type { ExecutionService } from './ExecutionService.js'

/** Poll cadence + budgets for the gates a parked run waits on. */
export interface DriveConfig {
  jobPollIntervalMs: number
  jobMaxPolls: number
  jobPollFailureTolerance: number
  ciPollIntervalMs: number
  ciMaxPolls: number
  /**
   * Ceiling on ONE `advanceInstance` call, enforced through {@link DriveOptions.withAdvanceCeiling}.
   * `0` means unbounded, which is what the deterministic conformance/unit fakes want: they own
   * no clock, and an advance that never settles there is a test bug, not a production hang.
   */
  advanceTimeoutMs: number
}

/** What {@link DriveOptions.withAdvanceCeiling} answers: the advance settled, or the ceiling won. */
export type AdvanceOutcome<T> = { timedOut: false; value: T } | { timedOut: true }

/** Runtime seams the driver loop needs; both have inert defaults. */
export interface DriveOptions {
  /**
   * How to wait between gate polls. Orchestration is runtime-neutral (no timers), so
   * the default resolves INSTANTLY; the Node service injects a real `setTimeout` sleep
   * (see its `drive.ts` wrapper), and the conformance harness keeps the instant default
   * to drive the deterministic fakes without real waiting.
   */
  sleep?: (ms: number) => Promise<void>
  /** Where to log lifecycle breadcrumbs. Defaults to a no-op. */
  log?: Logger
  /**
   * Bound ONE `advanceInstance` call at `cfg.advanceTimeoutMs`. Same seam shape as `sleep`, and
   * for the same reason: orchestration owns no timers, so the facade supplies the clock (the Node
   * `drive.ts` wrapper injects a `Promise.race`; the Cloudflare driver never runs this loop, it
   * applies the same ceiling as its `step.do` timeout).
   *
   * The advance is ABANDONED rather than aborted on a timeout (a promise cannot be cancelled),
   * so a late writer can still land afterwards; every run write goes through the rev-guarded
   * `casPersist`, which is what makes abandoning it safe rather than a lost-update race.
   */
  withAdvanceCeiling?: <T>(work: Promise<T>, ms: number) => Promise<AdvanceOutcome<T>>
}

/** What a drive ended on, so the runner can schedule follow-up work (a decision timeout). */
export interface DriveOutcome {
  /** Set when the run parked awaiting a human decision/approval with this id. */
  parkedDecisionId?: string
  /**
   * Set when the drive released an unbounded-wait gate (`pollExhaustion: 'rearm'`, e.g.
   * `human-review`) after spending one in-process poll budget. The run stays `running`, so the
   * stale-run sweeper re-enqueues a fresh advance for the next poll cycle — the drive returns
   * rather than looping in-process so a single durable advance job never outlives its expire
   * cap (which would let a second worker double-drive the run).
   */
  rearmedGate?: boolean
}

const instantSleep = (): Promise<void> => Promise.resolve()

/** No facade clock wired (or `advanceTimeoutMs: 0`): await the advance as this loop always did. */
const unboundedAdvance = async <T>(work: Promise<T>): Promise<AdvanceOutcome<T>> => ({
  timedOut: false,
  value: await work,
})

/**
 * The ceiling in the coarsest unit that still states it truthfully, for the run's user-facing
 * failure ("did not complete within 5 minutes"). Production values are minutes; the smaller
 * units exist so a deployment that tightens the knob is quoted its own number back rather than
 * a rounded-to-nothing "0 seconds".
 */
function describeCeiling(ms: number): string {
  if (ms >= 60_000) {
    const minutes = Math.round(ms / 60_000)
    return `${minutes} minute${minutes === 1 ? '' : 's'}`
  }
  if (ms >= 1000) {
    const seconds = Math.round(ms / 1000)
    return `${seconds} second${seconds === 1 ? '' : 's'}`
  }
  return `${ms}ms`
}

/**
 * Drive one run to a standstill. The runtime-neutral driver loop: it contains NO
 * business logic — every decision lives in {@link ExecutionService} — and uses plain
 * async sleeps, so it is the exact analogue of the Cloudflare ExecutionWorkflow (which
 * wraps the same advance/poll calls in durable steps). The Node service's pg-boss
 * worker runs it with a real sleep + pino logger; the cross-runtime conformance harness
 * runs the SAME function (instant sleep, no-op log) against each facade's real store, so
 * the suite exercises the production driver rather than a hand-rolled twin — which is how
 * the companion-failure clobber (a second `failRun` overwriting the rich record with a
 * generic one) once slipped past the suite.
 *
 * On a human decision it parks (returning the id so the caller can arm a timeout); the
 * pg-boss runner re-enqueues an advance when the decision is resolved. All run state
 * lives in the store, so a re-run after a crash simply reads the current state.
 */
export async function driveExecution(
  exec: ExecutionService,
  workspaceId: string,
  executionId: string,
  cfg: DriveConfig,
  opts: DriveOptions = {},
): Promise<DriveOutcome> {
  const sleep = opts.sleep ?? instantSleep
  // `advanceTimeoutMs: 0` is the explicit opt-out, so a facade that wires the clock still gets
  // the unbounded await rather than a zero-length ceiling that fails every advance instantly.
  const withAdvanceCeiling =
    cfg.advanceTimeoutMs > 0 ? (opts.withAdvanceCeiling ?? unboundedAdvance) : unboundedAdvance
  // Bind the run's correlation ids ONCE, so every line the driver emits — including the
  // poll-failure warnings below, which fire deep inside `pollUntil` — is greppable by run
  // without each call site re-spreading them.
  const log = (opts.log ?? noopLogger).child({ workspaceId, executionId })
  // ONE funnel taking the shared {@link RunFailure}, so this driver and the Cloudflare
  // `ExecutionWorkflow` record byte-identical failures derived by the same three functions
  // rather than each assembling positional arguments of its own.
  const fail = (failure: RunFailure) =>
    exec.failRun(
      workspaceId,
      executionId,
      failure.message,
      failure.kind,
      failure.detail,
      failure.reason,
    )

  // Poll a parked gate (job / CI / conflicts) until it yields a non-awaiting result
  // or the budget is spent. Tolerates a bounded run of status-read failures.
  // `pollFirst` runs the first poll BEFORE any sleep — the shape for a just-dispatched
  // container job, where a leading full interval (default 15s) is pure dead air between
  // "job accepted" and the first running/subtask state reaching the board. It is safe
  // because dispatch registered the job synchronously before `advanceInstance` returned
  // `awaiting_job`, so the immediate first `pollAgentJob` can only read back `awaiting_job`
  // (still running) — never a spurious terminal from an unregistered job. A transient read
  // failure isn't a terminal either: it's caught and retried on the next iteration, which
  // sleeps first. Gates keep the sleep-first shape: their precheck ran moments ago inside
  // advanceInstance / pollGate, so an immediate re-probe would only duplicate an external
  // status read.
  const pollUntil = async (
    awaiting: AdvanceResult['kind'],
    poll: () => Promise<AdvanceResult>,
    intervalMs: number,
    maxPolls: number,
    label: string,
    // Named distinctly from the outer `driveExecution` `opts` (DriveOptions) to avoid
    // shadowing it.
    pollOpts: { pollFirst?: boolean; onExhausted?: () => Promise<AdvanceResult> } = {},
  ): Promise<AdvanceResult | null> => {
    let readFailures = 0
    for (let p = 0; p < maxPolls; p++) {
      if (p > 0 || !pollOpts.pollFirst) await sleep(intervalMs)
      let result: AdvanceResult
      try {
        result = await poll()
      } catch (error) {
        // A bare `catch` used to discard the cause, so a run killed by three unreadable polls
        // reported "status was unreadable (3 polls)" with the actual reason (DNS, TLS, a 502)
        // existing NOWHERE on Node/local — the Cloudflare twin has always appended it.
        readFailures += 1
        const cause = describeError(error)
        log.warn('run poll failed', { ...cause, label, readFailures })
        if (readFailures >= cfg.jobPollFailureTolerance) {
          await fail(
            failureFromDriver(
              `${label} status was unreadable (${readFailures} polls)` +
                (cause.err ? ` (last error: ${String(cause.err)})` : ''),
              'timeout',
            ),
          )
          return null
        }
        continue
      }
      readFailures = 0
      if (result.kind !== awaiting) return result
    }
    // Budget spent. A gate may resolve exhaustion itself (a watch gate PASSES rather than
    // timing out) — let it; otherwise fail the run as a generic timeout.
    if (pollOpts.onExhausted) return pollOpts.onExhausted()
    await fail(failureFromDriver(`${label} did not settle within its polling budget`, 'timeout'))
    return null
  }

  for (;;) {
    let outcome: AdvanceOutcome<AdvanceResult>
    try {
      // Bounded, because nothing else bounds it: pg-boss heartbeats an ACTIVE job regardless of
      // handler progress, so a hung call inside an advance leaves the run `running` with a live
      // job and a frozen `updated_at`: the sweeper classifies it `live` and skips it, and the
      // run wedges until the queue's expire cap (up to 24h). Cloudflare has always capped the
      // same call at its `step.do` timeout; this restores the symmetry (stuck-run audit F9).
      outcome = await withAdvanceCeiling(
        exec.advanceInstance(workspaceId, executionId, { rethrowAgentErrors: true }),
        cfg.advanceTimeoutMs,
      )
    } catch (error) {
      // A thrown `DomainError` carries a machine-readable `details.reason` (e.g. a
      // `providers_unconfigured` conflict) — precisely the failure class the SPA has a
      // remedy for. Lift it onto the run instead of leaving only prose behind; the
      // step-result path below has always forwarded `reason`, so the throw path dropping
      // it was the asymmetry (observability-logging-gaps.md, B3).
      await fail(failureFromAdvanceError(error))
      return {}
    }

    if (outcome.timedOut) {
      // A `timeout` kind, not the `agent` one a thrown advance records: nothing reached an
      // agent, and the operator's fix is the wedged dependency, not a transcript.
      log.warn('advance exceeded its ceiling; failing the run', { ceilingMs: cfg.advanceTimeoutMs })
      await fail(
        failureFromDriver(
          `Step advance did not complete within ${describeCeiling(cfg.advanceTimeoutMs)}`,
          'timeout',
        ),
      )
      return {}
    }
    let result: AdvanceResult = outcome.value

    // Drain whatever gate the step parked on. A gate poll can resolve to a DIFFERENT
    // gate — e.g. a `ci` step that finds CI red dispatches a `ci-fixer` and returns
    // `awaiting_job` — so loop until the result is no longer an awaiting_* gate rather
    // than relying on the next `advanceInstance` to re-establish the poll (which is why
    // the order of these checks must not matter). `pollUntil` itself is bounded, so the
    // outer guard only backstops a pathological gate↔gate ping-pong.
    let gateHops = 0
    const MAX_GATE_HOPS = 64
    while (gateHops++ < MAX_GATE_HOPS) {
      if (result.kind === 'awaiting_job') {
        const next = await pollUntil(
          'awaiting_job',
          () => exec.pollAgentJob(workspaceId, executionId),
          cfg.jobPollIntervalMs,
          cfg.jobMaxPolls,
          'Implementation job',
          { pollFirst: true },
        )
        if (!next) return {}
        result = next
        continue
      }
      // A polling gate step (`ci` / `conflicts`): re-run its precheck between sleeps;
      // which gate is resolved inside `pollGate` from the current step, so one branch
      // drives both.
      if (result.kind === 'awaiting_gate') {
        const next = await pollUntil(
          'awaiting_gate',
          () => exec.pollGate(workspaceId, executionId),
          cfg.ciPollIntervalMs,
          cfg.ciMaxPolls,
          'Gate precheck',
          { onExhausted: () => exec.resolveGatePollExhaustion(workspaceId, executionId) },
        )
        if (!next) return {}
        // An unbounded-wait gate (human-review) re-arms by returning `awaiting_gate` from
        // resolveGatePollExhaustion when its in-process poll budget is spent. RELEASE the drive
        // here instead of looping in-process: holding one durable advance job open for a
        // multi-day human review would outlive its expire cap (pg-boss caps it, unrefreshed by
        // heartbeats) and let a second worker double-drive. The run stays `running`, so the
        // stale-run sweeper re-enqueues a fresh advance for the next poll cycle — bounding every
        // advance job to one poll budget. (Cloudflare's ExecutionWorkflow drives with durable
        // sleeps, not this loop, so it keeps polling in place.)
        if (next.kind === 'awaiting_gate') return { rearmedGate: true }
        result = next
        continue
      }
      break
    }

    if (result.kind === 'job_failed') {
      // Single `failRun` funnel for a terminal step failure. An inline gate that already
      // knows the precise classification + diagnostic carries them on the result
      // (`failureKind`/`detail`) — e.g. an unparseable companion verdict
      // (`companion_rejected`, with its raw reply as detail) — so the run records the
      // accurate kind, hint and detail instead of a generic "container reported a
      // failure". Defaults to `job_failed` for a genuine container-job failure.
      await fail(failureFromResult(result))
      return {}
    }
    if (result.kind === 'job_evicted') {
      // Record the transport's container post-mortem as the failure detail — the container is
      // already reclaimed, so this is the only surviving account of why it died.
      await fail(failureFromResult(result))
      return {}
    }
    // done / noop / paused: stop. awaiting_decision: park (resumed on signalDecision).
    if (result.kind === 'done' || result.kind === 'noop' || result.kind === 'paused') return {}
    if (result.kind === 'awaiting_decision') {
      // `workspaceId`/`executionId` ride the bound child logger, so only the decision is new.
      log.info('run parked on decision', { decisionId: result.decisionId })
      return { parkedDecisionId: result.decisionId }
    }
    // 'continue': loop and advance the next step.
  }
}
