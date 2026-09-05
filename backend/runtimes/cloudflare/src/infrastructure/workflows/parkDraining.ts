import type { WorkflowSleepDuration, WorkflowStep, WorkflowStepConfig } from 'cloudflare:workers'
import type { Logger } from '@cat-factory/kernel'
import type { AdvanceResult, RunFailure } from '@cat-factory/orchestration'
import { failureFromDriver, MAX_PARK_HOPS } from '@cat-factory/orchestration'

// ---------------------------------------------------------------------------
// The durable park-draining loops for one pipeline run, lifted out of `ExecutionWorkflow` so that
// driver stays pure step sequencing and these stay independently testable. They contain NO
// business logic: every decision is the engine's, reached through the bound `poll` / `failRun` /
// `pollOnce` callbacks the driver supplies, so what is asserted here is exactly what a durable
// driver owns — which parks get drained, in what order, and under which durable step NAMES.
//
// The naming is the subtle half. Workflows memoises a durable step by name, so a name reused
// within one instance does not collide loudly: the second use silently REPLAYS the first's
// recorded answer. Every loop therefore takes a {@link PollLoopSite} scope rather than deriving
// its names from the step index alone.
// ---------------------------------------------------------------------------

/** Outcome of one durable status read: a settled result, or a tolerated transient read error. */
export type PollAttempt =
  | { kind: 'ok'; result: AdvanceResult }
  | { kind: 'read_failed'; message: string }

/**
 * The bound callbacks and knobs one durable poll loop needs. The two loops below are lifted out of
 * {@link ExecutionWorkflow.run} — which owns the run-scoped closures they call — so that driver
 * stays within the per-function line budget; they take those closures as deps rather than
 * re-deriving anything, so the loops remain pure control flow with no business logic of their own.
 */
export interface PollLoopDeps {
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
 * WHERE one poll loop is running: the step index it reports against, and the durable step-name
 * scope its own `step.do` / `step.sleep` names are built from.
 *
 * The two are separate because ONE step index drives SEVERAL loops — a `deployer` whose deploy job
 * finishes into an environment that is still building parks twice on the same index, and both
 * parks are drained by {@link drivePollLoop}. Workflows memoises a durable step by NAME, so two
 * loops sharing a scope do not merely collide: the second replays the FIRST's cached answers and
 * never issues a poll of its own, leaving the run to hop on a stale result. Scoping by hop is what
 * keeps every name distinct; {@link driveGatePollLoop} additionally has its own `gate-` prefix, so
 * it can never collide with the job/environment loop within one hop.
 */
interface PollLoopSite {
  /** The pipeline step index: `log.warn` fields and the step a failure is recorded against. */
  index: number
  /** The unique-per-loop durable name scope, `<step>-<hop>`. */
  scope: string
}

/** {@link PollLoopDeps} plus the gate's own budget-exhaustion policy (see `driveGatePollLoop`). */
export type GatePollLoopDeps = PollLoopDeps & { resolveExhaustion: () => Promise<AdvanceResult> }

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
  site: PollLoopSite,
  initial: AdvanceResult,
): Promise<AdvanceResult | null> {
  const { step, log, maxPolls, failureTolerance, pollInterval, pollOnce, failRun, poll } = deps
  const { index, scope } = site
  const awaiting = deps.awaiting ?? 'awaiting_job'
  const label = deps.label ?? 'Implementation job'
  let result = initial
  let polled = false
  let pollReadFailures = 0
  for (let p = 0; p < maxPolls; p++) {
    // Poll-first: the job was dispatched instants ago by `advance-${index}`, so the first
    // status read runs immediately — a leading sleep would be a full poll interval of
    // dead air. Later iterations sleep between polls.
    if (p > 0 || deps.pollFirst === false) await step.sleep(`poll-wait-${scope}-${p}`, pollInterval)
    const attempt = await pollOnce(`poll-${scope}-${p}`, poll)
    if (attempt.kind === 'read_failed') {
      pollReadFailures += 1
      log.warn('poll could not read job status; treating as still running and retrying', {
        step: index,
        poll: p,
        pollReadFailures,
        err: attempt.message,
      })
      if (pollReadFailures < failureTolerance) continue
      await failRun(
        index,
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
      index,
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
  deps: GatePollLoopDeps,
  site: PollLoopSite,
  initial: AdvanceResult,
): Promise<AdvanceResult | null> {
  const { step, log, maxPolls, failureTolerance, pollInterval, pollOnce, failRun, poll } = deps
  const { index, scope } = site
  let result = initial
  let settled = false
  let pollReadFailures = 0
  for (let p = 0; p < maxPolls; p++) {
    await step.sleep(`gate-wait-${scope}-${p}`, pollInterval)
    const attempt = await pollOnce(`gate-poll-${scope}-${p}`, poll)
    if (attempt.kind === 'read_failed') {
      pollReadFailures += 1
      log.warn('gate poll could not read its precheck; treating as still pending and retrying', {
        step: index,
        poll: p,
        pollReadFailures,
        err: attempt.message,
      })
      if (pollReadFailures < failureTolerance) continue
      await failRun(
        index,
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
      `gate-exhausted-${scope}`,
      deps.stepConfig,
      deps.resolveExhaustion,
    )) as AdvanceResult
  }
  return result
}

/**
 * Drain every park step `i` lands on, until the result is something the driver can act on.
 *
 * Lifted out of {@link ExecutionWorkflow.drive} for the same reason the two poll loops above were:
 * it is pure control flow over run-scoped closures, and it keeps that driver within its statement
 * budget. Returns the drained result, or `null` once a loop has already failed the run.
 */
export async function drainParks(
  deps: { job: PollLoopDeps; gate: GatePollLoopDeps },
  i: number,
  initial: AdvanceResult,
): Promise<AdvanceResult | null> {
  let result = initial
  // Keep draining: a poll routinely resolves into a DIFFERENT park rather than into a terminal
  // result. A `ci` gate that finds CI red dispatches a `ci-fixer` and returns `awaiting_job`; a
  // deploy job whose provider is still building returns `awaiting_environment`. So loop until the
  // result is no longer a park, rather than letting an un-drained one fall through to the next
  // `advanceInstance` to re-establish — which is exactly why the ORDER of these branches must not
  // matter, and why this mirrors the hop loop in `drive.ts` (same `MAX_PARK_HOPS` bound) instead
  // of the flat branch sequence it replaces. That sequence silently dropped any park raised by a
  // branch EARLIER than the one already taken: an `awaiting_environment` raised by the deploy-job
  // poll (an async provider still answering `provisioning` as its container finishes) matched no
  // remaining branch at all, so the driver re-advanced and stood a second environment up for the
  // same frame.
  //
  // Each hop gets its OWN durable name scope (see {@link PollLoopSite}); sharing one would have
  // the second loop replay the first's memoised polls instead of issuing any of its own.
  for (let hop = 0; hop < MAX_PARK_HOPS; hop++) {
    const site: PollLoopSite = { index: i, scope: `${i}-${hop}` }
    // An async step (a container coding job) dispatched and parked. Poll it between durable
    // sleeps until it finishes — each poll is its own short, retriable step, so the job can run
    // far longer than one step's timeout while the driver stays cheap and survives eviction. The
    // job's bound is enforced container-side (inactivity + max-duration watchdogs); `jobMaxPolls`
    // is only a backstop.
    if (result.kind === 'awaiting_job') {
      const polled = await drivePollLoop(deps.job, site, result)
      if (polled === null) return null
      result = polled
      continue
    }
    // A `deployer` step is waiting for the environment it provisioned to become ready. Re-read
    // the provider between durable sleeps on the JOB cadence (infra coming up, not a human-scale
    // gate), through the same `pollAgentJob` entry point. The wait's own ceiling settles it long
    // before this budget does.
    if (result.kind === 'awaiting_environment') {
      const waited = await drivePollLoop(
        {
          ...deps.job,
          awaiting: 'awaiting_environment',
          label: 'Environment readiness',
          // Sleep-first, matching `drive.ts`: the advance that parked the step read the provider
          // moments ago.
          pollFirst: false,
        },
        site,
        result,
      )
      if (waited === null) return null
      result = waited
      continue
    }
    // A polling gate step (`ci` / `conflicts` / post-release-health) is gating the PR on its
    // precheck. Re-run the precheck between durable sleeps until the gate yields something
    // terminal (see {@link driveGatePollLoop}). One loop drives every gate kind, since which gate
    // is resolved inside `pollGate` from the current step.
    if (result.kind === 'awaiting_gate') {
      const gated = await driveGatePollLoop(deps.gate, site, result)
      if (gated === null) return null
      result = gated
      // An unbounded-wait gate (human review) RE-ARMS by returning `awaiting_gate` from
      // `resolveGatePollExhaustion`. Stop hopping and hand it back for a re-advance: another hop
      // would spend a whole fresh poll budget of durable sleeps inside this instance for a wait
      // that can last days, where re-advancing re-establishes the identical park and keeps the
      // step history bounded (the same limit the driver's `paused` branch parks on `waitForEvent`
      // to respect). `drive.ts` releases its in-process drive here for the sibling reason.
      if (result.kind === 'awaiting_gate') break
      continue
    }
    break
  }
  return result
}
