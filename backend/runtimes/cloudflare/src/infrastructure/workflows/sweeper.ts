import type {
  AgentRunRef,
  AgentRunRepository,
  Clock,
  EnvironmentTestRunRecord,
  Logger,
  OperationalMetrics,
} from '@cat-factory/kernel'
import {
  describeError,
  noopLogger,
  noopOperationalMetrics,
  redactSecrets,
  runBestEffort,
} from '@cat-factory/kernel'
import type { Workflow } from '@cloudflare/workers-types'

/**
 * A run's durable instance, as the sweeper needs to classify it:
 *   - `alive`    : running/queued/waiting/paused/waitingForPause; leave it.
 *   - `terminal` : the instance exists but completed/errored/terminated. It can NOT
 *                  be recreated (instance ids are unique), so a re-drive via
 *                  `create` is a silent no-op and the run must be FINALIZED instead.
 *   - `missing`  : no instance for this id; safe to (re-)create via `redrive`.
 *   - `unknown`  : the probe could not classify the instance. The Workflows API refused the
 *                  lookup, the binding for this run's kind is unconfigured, or Workflows
 *                  itself answered `unknown`. Every disposition the sweeper has is DESTRUCTIVE
 *                  against a live run (a re-drive of a run that is fine is at best wasted, a
 *                  finalize kills it outright), so this state buys the run one more tick
 *                  instead of guessing. It exists because the two swallows this replaced both
 *                  answered `missing`, which made a Workflows outage read as every stale run
 *                  having lost its instance at once, and re-drove the whole fleet with no log
 *                  line to say why.
 */
type InstanceState = 'alive' | 'terminal' | 'missing' | 'unknown'

/** What the probe learned about a run's durable instance. */
export interface InstanceProbe {
  state: InstanceState
  /**
   * What the probe learned beyond the state, already scrubbed and capped for a surface a
   * person reads:
   *   - on `terminal`, the instance's OWN error (`InstanceStatus.error`) when Workflows
   *     reported one. It is the only account of why the driver died that survives the
   *     instance, and the run is about to be stopped with a fixed sentence that says nothing.
   *   - on `unknown`, why the lookup could not classify.
   *
   * Absent when there is nothing to say, which is not the same as an empty string: a terminal
   * instance that Workflows reports no error for ended on purpose.
   */
  detail?: string
}

/** Tells the sweeper the state of a run's durable instance. */
interface WorkflowLookup {
  instanceState(runId: string): Promise<InstanceProbe>
}

/**
 * How much of an instance's own error text is carried onto the run's stop reason. It is
 * rendered in the run's details, so it is a sentence or two of context, not a transcript.
 */
const INSTANCE_DETAIL_CAP = 400

/**
 * Workflows' code for "no instance with this id". It rides the error MESSAGE
 * (`(instance.not_found) Instance does not exist` from the API, a bare `instance.not_found`
 * from the local binding); the binding's own `WorkflowError.code` is a NUMBER, so this string
 * is the only spelling stable across both.
 */
const INSTANCE_NOT_FOUND_CODE = 'instance.not_found'

/** How far down a `cause` chain the classification below looks before giving up. */
const CAUSE_DEPTH = 4

/**
 * The message a thrown value carries, whatever shape it arrived in.
 *
 * Reading `.message` only off an `Error` is the trap: `Workflow.get` is declared to reject with
 * a plain `WorkflowError` (`{ code?: number; message: string }`), which is not an `Error`, so an
 * `instanceof` test falls through to `String(error)` and renders it `[object Object]`. That
 * silently makes `missing` unreachable, and with it the ENTIRE stale-run backstop: every probe
 * answers `unknown`, which by design takes no action at all. Empty when the value carries no
 * message, so a caller can tell "nothing said" from "said nothing useful".
 */
function messageOf(error: unknown): string {
  if (typeof error === 'string') return error
  if (error instanceof Error) return error.message
  if (typeof error === 'object' && error !== null) {
    const { message } = error as { message?: unknown }
    if (typeof message === 'string') return message
  }
  return ''
}

/**
 * Whether a lookup throw means "no instance with this id" (the state the sweeper acts on)
 * rather than "the lookup failed" (which says nothing about the run).
 *
 * Matching the CODE rather than the prose keeps it stable across Workflows' two spellings, and
 * walking the `cause` chain keeps it stable across a binding shim that re-throws wrapping the
 * original. Anything else (a quota rejection, an unbound namespace, an API outage) is a lookup
 * failure and must NOT be reported as a lost instance.
 *
 * A misclassification here is invisible in the sweep's dispositions, which is what
 * `sweep.run_state_unknown` is counted for: a sweeper that can no longer recognise the code
 * reports every stale run as unclassifiable rather than re-driving none of them quietly.
 */
function isInstanceNotFound(error: unknown): boolean {
  let current: unknown = error
  for (let depth = 0; depth < CAUSE_DEPTH && current != null; depth++) {
    if (messageOf(current).includes(INSTANCE_NOT_FOUND_CODE)) return true
    current = (current as { cause?: unknown }).cause
  }
  return false
}

/**
 * Prepare free text for {@link InstanceProbe.detail}: scrub, trim, cap. Workflows echoes the
 * step's own throw, which routinely carries a URL or a provider response, and this lands on a
 * run surface a person reads. Empty in ⇒ empty out, so the caller can tell "nothing to say"
 * from "said nothing useful".
 */
function probeDetail(text: string): string {
  const scrubbed = (redactSecrets(text.trim()) ?? '').trim()
  return scrubbed.length > INSTANCE_DETAIL_CAP
    ? `${scrubbed.slice(0, INSTANCE_DETAIL_CAP)}…`
    : scrubbed
}

/** The instance's own error, scrubbed and capped; empty when Workflows reported none. */
function describeInstanceError(error: { name?: string; message?: string } | undefined): string {
  if (!error) return ''
  return probeDetail([error.name, error.message].filter(Boolean).join(': '))
}

/**
 * Why a lookup could not answer, scrubbed and capped. Reads the message off whatever shape the
 * throw arrived in (see {@link messageOf}) rather than stringifying it, since the plain
 * `WorkflowError` the binding is declared to reject with renders as `[object Object]` and would
 * put a run's only account of an outage as literally nothing.
 */
function describeLookupFailure(error: unknown): string {
  const message = messageOf(error)
  if (!message) return probeDetail(safeStringify(error))
  const name = error instanceof Error ? error.name : ''
  return probeDetail(name ? `${name}: ${message}` : message)
}

/** A last-resort rendering of a throw that carries no message. Never throws itself. */
function safeStringify(error: unknown): string {
  try {
    return typeof error === 'object' && error !== null ? JSON.stringify(error) : String(error)
  } catch {
    // silent-catch-ok: the value is unserialisable (a cycle, a throwing getter); its type is
    // the only honest thing left to say about it, and this is already the fallback path.
    return Object.prototype.toString.call(error)
  }
}

/** WorkflowLookup over a Cloudflare Workflows binding. */
export class WorkflowsLookup implements WorkflowLookup {
  constructor(
    private readonly workflow: Workflow,
    private readonly log: Logger = noopLogger,
  ) {}

  async instanceState(runId: string): Promise<InstanceProbe> {
    let instance
    try {
      instance = await this.workflow.get(runId)
    } catch (error) {
      if (isInstanceNotFound(error)) return { state: 'missing' }
      // The lookup itself failed. Reporting `missing` here is how one Workflows outage became
      // a fleet-wide re-drive; report that we do not know instead, and name the cause.
      this.log.warn('workflow instance lookup failed', { runId, ...describeError(error) })
      return { state: 'unknown', detail: describeLookupFailure(error) }
    }
    try {
      const { status, error } = await instance.status()
      if (
        status === 'running' ||
        status === 'queued' ||
        status === 'waiting' ||
        status === 'paused' ||
        // Finishing the current work before parking: still driving the run, so leaving it
        // alone is right. Absent from the alive set it fell through to `terminal`, and the
        // sweeper force-stopped a run that was pausing exactly as it was asked to.
        status === 'waitingForPause'
      ) {
        return { state: 'alive' }
      }
      // Workflows' OWN "I cannot tell you" answer. It shares the fall-through with the genuine
      // terminal states, so it used to finalize the run, the most destructive disposition
      // available, taken on the one answer that carries no information.
      if (status === 'unknown') {
        this.log.warn('workflow instance status is unknown', { runId })
        return { state: 'unknown', detail: 'Workflows reported the instance status as unknown.' }
      }
      const detail = describeInstanceError(error)
      return { state: 'terminal', ...(detail ? { detail } : {}) }
    } catch (error) {
      // The handle `get` hands back is LAZY: it resolves nothing, so "no instance with this id"
      // routinely surfaces here rather than from `get`. It is the same fact and takes the same
      // classification, or a genuinely lost instance reads as an unreadable one and is never
      // re-created.
      if (isInstanceNotFound(error)) return { state: 'missing' }
      this.log.warn('workflow instance status unreadable', { runId, ...describeError(error) })
      return { state: 'unknown', detail: describeLookupFailure(error) }
    }
  }
}

export interface SweepDeps {
  agentRunRepository: AgentRunRepository
  /** State of the durable instance backing this run (by kind). */
  instanceState(ref: AgentRunRef): Promise<InstanceProbe>
  /** (Re-)create the durable driver for a run whose instance is `missing`. */
  redrive(ref: AgentRunRef): Promise<void>
  /**
   * Finalize a run whose instance is `terminal` (so it can't be re-created): mark it
   * stopped/failed and reclaim any leftover container, routed by kind. Without this,
   * such a run would show as `running` forever (the re-drive is a silent no-op).
   *
   * `cause` is the dead instance's own account of itself ({@link InstanceProbe.detail}), when
   * Workflows kept one. It is the only thing that distinguishes the runs this branch settles,
   * all of which otherwise carry the same fixed sentence, so it belongs in the stop reason
   * rather than only in a log line the operator has to go and find.
   */
  finalizeOrphan(ref: AgentRunRef, cause?: string): Promise<void>
  /**
   * Fail an execution run whose instance stayed `missing` past the hard-stall deadline —
   * re-driving isn't resurrecting it, so flag it `stalled` (loud banner + retry) instead of
   * re-creating forever. Symmetric with the Node sweeper's hard-stall backstop.
   */
  failStalled(ref: AgentRunRef): Promise<void>
  clock: Clock
  /** A run is considered stuck if its lease is older than this many ms. */
  leaseMs: number
  /** A `missing` execution stale longer than this is failed `stalled` instead of re-driven. */
  hardStallMs: number
  /**
   * Per-process "first observed orphaned" clock, keyed by run id, MUTATED IN PLACE across
   * sweeps. The hard-stall deadline is measured from this — NOT the raw lease age
   * (`ref.updatedAt`) — so a cron outage / deploy freeze / sustained sweep failure longer than
   * `hardStallMs` can't fail an otherwise-recoverable run on the very first post-outage tick
   * (lease age inflates during the gap, but observed-orphaned time does not). This mirrors the
   * Node sweeper's `orphanedSince` map. Pass a caller-owned persistent map (e.g. a
   * module-global in the cron handler) to get cross-tick memory; omit it and each sweep is
   * independent — the hard-stall backstop then only fires for a non-positive `hardStallMs`
   * (the degenerate unit-test case), never wrongly on a first observation.
   */
  orphanedSince?: Map<string, number>
  /**
   * Counts each disposition (re-drive / finalize / stall). The per-sweep RESULT below already
   * carries these numbers, but only for this tick's log line: nothing accumulates them, so
   * "has the re-drive rate tripled since the deploy" was unanswerable except by grepping.
   * Absent ⇒ uncounted (a unit test).
   */
  metrics?: OperationalMetrics
  /** Reports the best-effort re-drive bookkeeping below. Absent ⇒ silent (a unit test). */
  logger?: Logger
}

/** What a sweep did, for logging. */
export interface SweepResult {
  /**
   * Runs the pass TOOK ON (the size of its stale list), which is what makes {@link failed}
   * interpretable: with recovery isolated per run, "three runs threw" is a healthy sweeper on a
   * busy board and a completely wedged one on a list of three. `sweepPassRecoveredNothing` reads
   * the pair and decides which, and the pass's health report follows that answer.
   */
  attempted: number
  /** Runs whose lost instance was re-created. */
  redriven: number
  /** Runs whose instance was terminal and so were finalized instead. */
  finalized: number
  /** Runs failed `stalled` (instance missing past the hard-stall deadline). */
  stalled: number
  /**
   * Runs the probe could not classify, so the sweep left them alone. Reported apart from the
   * three dispositions because it is not one: a rising number here means the sweeper is
   * BLIND, which reads in every other number as a fleet that suddenly went quiet.
   */
  unknown: number
  /**
   * Runs whose recovery THREW, so the sweep moved on to the next one. Not a disposition either:
   * the run got neither re-driven nor settled, and the pass continued only because it is
   * isolated per run (see {@link recoverStaleRun}).
   */
  failed: number
}

/**
 * Backstop for runs that are still `running` in storage but whose Workflows
 * instance is no longer driving them. Cron invokes this across BOTH agent flows
 * (execution + bootstrap). For each stale run it inspects the durable instance:
 *   - `missing`  → re-create it (the instance was lost: eviction, a missed event).
 *   - `terminal` → FINALIZE the run (the instance completed/terminated and can't be
 *                  recreated under the same id, so re-driving is a no-op — without
 *                  this the run would be stuck `running` forever).
 *   - `alive`    → leave it.
 *   - `unknown`  → leave it, count it, and forget its orphan clock. The sweep acts on what it
 *                  KNOWS; an unclassifiable instance costs the run one tick of recovery
 *                  latency, where guessing costs a live run its container or an orphan its
 *                  place in the queue for as long as the outage lasts.
 * Pure orchestration over its ports so it is unit-testable with fakes.
 */
export async function sweepStuckRuns({
  agentRunRepository,
  instanceState,
  redrive,
  finalizeOrphan,
  failStalled,
  clock,
  leaseMs,
  hardStallMs,
  orphanedSince = new Map<string, number>(),
  metrics = noopOperationalMetrics,
  logger = noopLogger,
}: SweepDeps): Promise<SweepResult> {
  const now = clock.now()
  const stale = await agentRunRepository.listStale(now - leaseMs)
  const tally: SweepResult = {
    attempted: stale.length,
    redriven: 0,
    finalized: 0,
    stalled: 0,
    unknown: 0,
    failed: 0,
  }
  // Which runs' per-process orphaned clock survives THIS tick: the ones observed still-orphaned
  // (`missing`), plus the ones nothing could observe because their own recovery threw. Every other
  // run's clock is pruned below, so its deadline restarts if it ever stalls again.
  const keepOrphanClock = new Set<string>()
  for (const ref of stale) {
    // ISOLATED PER RUN, the same rule as the Node sweeper's `reenqueueStaleRuns`. Recovering a
    // run probes a durable instance and can settle the run itself, so any one of them can throw
    // for reasons entirely its own; `listStale` is ordered OLDEST FIRST, so an unrecoverable run
    // sorts to the front of every future pass. Left to propagate, one such run ends the pass and
    // takes every stale run behind it down with it, tick after tick, while the cron keeps
    // reporting that it ran.
    try {
      await recoverStaleRun(ref)
    } catch (error) {
      tally.failed++
      logger.error('stale-run recovery failed for one run; continuing the sweep', {
        workspaceId: ref.workspaceId,
        runId: ref.id,
        kind: ref.kind,
        ...describeError(error),
      })
      metrics.increment('sweep.run_recovery_failed', { kind: ref.kind })
      // This run made no OBSERVATION, so its orphan clock is carried forward rather than pruned
      // below. Nothing here claims it is still orphaned; the claim is only that nothing learned
      // otherwise. Left out, a probe that throws every pass resets the hard-stall deadline every
      // pass and the backstop that exists to settle an unrecoverable run could never fire. Before
      // the isolation the throw propagated and the prune loop was never reached, which preserved
      // the clock by accident; it has to be deliberate now.
      keepOrphanClock.add(ref.id)
    }
  }
  // Forget runs that recovered (bumped their lease → left the stale set) or went terminal, so
  // their per-process orphaned clock restarts if they ever stall again.
  for (const id of orphanedSince.keys()) {
    if (!keepOrphanClock.has(id)) orphanedSince.delete(id)
  }
  return tally

  /** Recover ONE stale run, tallying its disposition. Hoisted so the loop above stays the
   *  isolation boundary and nothing else. */
  async function recoverStaleRun(ref: AgentRunRef): Promise<void> {
    const { state, detail } = await instanceState(ref)
    if (state === 'alive') {
      orphanedSince.delete(ref.id)
      return
    }
    if (state === 'unknown') {
      // Forget the orphan clock rather than carrying it: the run was NOT observed orphaned
      // this tick, and letting an outage age a deadline nobody could measure is how a
      // Workflows incident would come out the far side as a batch of `stalled` runs. The
      // deadline restarts from the next observation that actually saw something, which also
      // guarantees the run is re-driven at least once before it can be given up on.
      orphanedSince.delete(ref.id)
      tally.unknown++
      metrics.increment('sweep.run_state_unknown', { kind: ref.kind })
      return
    }
    if (state === 'terminal') {
      orphanedSince.delete(ref.id)
      await finalizeOrphan(ref, detail)
      tally.finalized++
      // The run KIND is a bounded enum and the split that matters: bootstrap runs and
      // execution runs are lost for different reasons and fixed in different places.
      metrics.increment('sweep.run_finalized', { kind: ref.kind })
      return
    }
    // `missing`: the instance was lost (eviction, a missed event) and can be re-created.
    // Start (or carry forward) this run's per-process orphaned clock so the hard-stall
    // deadline below measures time-observed-orphaned, not raw lease age — a run first seen
    // orphaned this tick (e.g. right after a long cron outage) is always re-driven at least
    // once before it can ever be given up on.
    const firstSeenOrphaned = orphanedSince.get(ref.id) ?? now
    orphanedSince.set(ref.id, firstSeenOrphaned)
    keepOrphanClock.add(ref.id)
    // An execution stuck `missing` past the hard deadline (re-driving isn't resurrecting it)
    // is failed `stalled` so it stops showing `running` forever and surfaces the failure
    // banner + retry.
    if (ref.kind === 'execution' && now - firstSeenOrphaned > hardStallMs) {
      await failStalled(ref)
      tally.stalled++
      metrics.increment('sweep.run_stalled', { kind: ref.kind })
      orphanedSince.delete(ref.id)
      keepOrphanClock.delete(ref.id)
      return
    }
    await redrive(ref)
    tally.redriven++
    metrics.increment('sweep.run_redriven', { kind: ref.kind })
    // Persist the per-run count AFTER the re-drive and best-effort: this is bookkeeping about
    // the recovery, so it must never be able to fail one. Ordered after for the same reason —
    // a counter claiming a run was re-driven when it was not is worse than one that missed.
    await runBestEffort(logger, 'sweep.recordRedrive', () =>
      agentRunRepository.recordRedrive(ref.workspaceId, ref.id),
    )
  }
}

export interface EnvTestSweepDeps {
  repository: { listStale(cutoffMs: number): Promise<EnvironmentTestRunRecord[]> }
  /** State of the run's EnvironmentTestWorkflow instance. */
  instanceState(runId: string): Promise<InstanceProbe>
  /** (Re-)create the durable driver for a run whose instance is `missing`. */
  redrive(workspaceId: string, runId: string): Promise<void>
  /**
   * Finalize a run whose instance is `terminal` (it can't be re-created under the same
   * id): best-effort cleanup + mark it failed, via `EnvironmentTestService.expire`.
   * `cause` is the dead instance's own error when Workflows kept one (see {@link SweepDeps}).
   */
  finalizeOrphan(workspaceId: string, runId: string, cause?: string): Promise<void>
  clock: Clock
  /** A run is considered stuck if its record hasn't been touched in this many ms. */
  leaseMs: number
}

/**
 * The env-test sibling of {@link sweepStuckRuns}: self-test runs live in their own
 * `environment_test_runs` table (not `agent_runs`), so the unified run sweep never sees
 * them — without this, a run whose Workflows instance was lost (eviction, a silently
 * failed `create`) or ended without settling it (poll budget exhausted before the
 * self-finalize landed, a terminal instance error) would show `running` forever. Note a
 * long provisioning legitimately leaves `updatedAt` untouched between stage transitions,
 * so a stale lease alone proves nothing — the instance lookup disambiguates (`alive` →
 * leave it; a re-drive of an alive instance would be a no-op anyway).
 */
export async function sweepStuckEnvTests({
  repository,
  instanceState,
  redrive,
  finalizeOrphan,
  clock,
  leaseMs,
}: EnvTestSweepDeps): Promise<{ redriven: number; finalized: number; unknown: number }> {
  const stale = await repository.listStale(clock.now() - leaseMs)
  let redriven = 0
  let finalized = 0
  let unknown = 0
  for (const run of stale) {
    const { state, detail } = await instanceState(run.id)
    if (state === 'alive') continue
    // Unclassifiable: leave it for the next tick, exactly like the run sweep. Re-driving a
    // test whose instance is alive would be harmless, but expiring one that is provisioning
    // real infrastructure is not, and neither disposition is safe to take blind.
    if (state === 'unknown') {
      unknown++
      continue
    }
    if (state === 'terminal') {
      await finalizeOrphan(run.workspaceId, run.id, detail)
      finalized++
      continue
    }
    await redrive(run.workspaceId, run.id)
    redriven++
  }
  return { redriven, finalized, unknown }
}
