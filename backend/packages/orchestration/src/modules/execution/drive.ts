import type { AgentFailureKind } from '@cat-factory/kernel'
import type { AdvanceResult } from './advance.js'
import type { ExecutionService } from './ExecutionService.js'

/** Poll cadence + budgets for the gates a parked run waits on. */
export interface DriveConfig {
  jobPollIntervalMs: number
  jobMaxPolls: number
  jobPollFailureTolerance: number
  ciPollIntervalMs: number
  ciMaxPolls: number
}

/** Minimal structured logger the driver needs (pino is structurally compatible). */
export interface DriveLogger {
  info(obj: unknown, msg?: string): void
}

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
  log?: DriveLogger
}

/** What a drive ended on, so the runner can schedule follow-up work (a decision timeout). */
export interface DriveOutcome {
  /** Set when the run parked awaiting a human decision/approval with this id. */
  parkedDecisionId?: string
}

const instantSleep = (): Promise<void> => Promise.resolve()
const noopLogger: DriveLogger = { info() {} }

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
  const log = opts.log ?? noopLogger
  const fail = (message: string, kind: AgentFailureKind = 'agent', detail: string | null = null) =>
    exec.failRun(workspaceId, executionId, message, kind, detail)

  // Poll a parked gate (job / CI / conflicts) until it yields a non-awaiting result
  // or the budget is spent. Tolerates a bounded run of status-read failures.
  const pollUntil = async (
    awaiting: AdvanceResult['kind'],
    poll: () => Promise<AdvanceResult>,
    intervalMs: number,
    maxPolls: number,
    label: string,
  ): Promise<AdvanceResult | null> => {
    let readFailures = 0
    for (let p = 0; p < maxPolls; p++) {
      await sleep(intervalMs)
      let result: AdvanceResult
      try {
        result = await poll()
      } catch {
        readFailures += 1
        if (readFailures >= cfg.jobPollFailureTolerance) {
          await fail(`${label} status was unreadable (${readFailures} polls)`, 'timeout')
          return null
        }
        continue
      }
      readFailures = 0
      if (result.kind !== awaiting) return result
    }
    await fail(`${label} did not settle within its polling budget`, 'timeout')
    return null
  }

  for (;;) {
    let result: AdvanceResult
    try {
      result = await exec.advanceInstance(workspaceId, executionId, { rethrowAgentErrors: true })
    } catch (error) {
      await fail(error instanceof Error ? error.message : String(error))
      return {}
    }

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
        )
        if (!next) return {}
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
      await fail(result.error, result.failureKind ?? 'job_failed', result.detail ?? null)
      return {}
    }
    if (result.kind === 'job_evicted') {
      await fail(result.error, 'evicted')
      return {}
    }
    // done / noop / paused: stop. awaiting_decision: park (resumed on signalDecision).
    if (result.kind === 'done' || result.kind === 'noop' || result.kind === 'paused') return {}
    if (result.kind === 'awaiting_decision') {
      log.info(
        { workspaceId, executionId, decisionId: result.decisionId },
        'run parked on decision',
      )
      return { parkedDecisionId: result.decisionId }
    }
    // 'continue': loop and advance the next step.
  }
}
