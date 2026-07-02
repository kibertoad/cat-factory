import type { AgentRunRef, AgentRunRepository, Clock } from '@cat-factory/kernel'
import type { Workflow } from '@cloudflare/workers-types'

/**
 * A run's durable instance, as the sweeper needs to classify it:
 *   - `alive`    — running/queued/waiting/paused; leave it.
 *   - `terminal` — the instance exists but completed/errored/terminated. It can NOT
 *                  be recreated (instance ids are unique), so a re-drive via
 *                  `create` is a silent no-op — the run must be FINALIZED instead.
 *   - `missing`  — no instance for this id; safe to (re-)create via `redrive`.
 */
export type InstanceState = 'alive' | 'terminal' | 'missing'

/** Tells the sweeper the state of a run's durable instance. */
export interface WorkflowLookup {
  instanceState(runId: string): Promise<InstanceState>
}

/** WorkflowLookup over a Cloudflare Workflows binding. */
export class WorkflowsLookup implements WorkflowLookup {
  constructor(private readonly workflow: Workflow) {}

  async instanceState(runId: string): Promise<InstanceState> {
    let instance
    try {
      instance = await this.workflow.get(runId)
    } catch {
      // No instance with this id was ever created → safe to create one.
      return 'missing'
    }
    try {
      const { status } = await instance.status()
      return status === 'running' ||
        status === 'queued' ||
        status === 'waiting' ||
        status === 'paused'
        ? 'alive'
        : 'terminal'
    } catch {
      // The instance handle resolved but status is unreadable — treat as missing so
      // the sweeper tries to (re-)create rather than wrongly finalizing a live run.
      return 'missing'
    }
  }
}

export interface SweepDeps {
  agentRunRepository: AgentRunRepository
  /** State of the durable instance backing this run (by kind). */
  instanceState(ref: AgentRunRef): Promise<InstanceState>
  /** (Re-)create the durable driver for a run whose instance is `missing`. */
  redrive(ref: AgentRunRef): Promise<void>
  /**
   * Finalize a run whose instance is `terminal` (so it can't be re-created): mark it
   * stopped/failed and reclaim any leftover container, routed by kind. Without this,
   * such a run would show as `running` forever (the re-drive is a silent no-op).
   */
  finalizeOrphan(ref: AgentRunRef): Promise<void>
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
}

/** What a sweep did, for logging. */
export interface SweepResult {
  /** Runs whose lost instance was re-created. */
  redriven: number
  /** Runs whose instance was terminal and so were finalized instead. */
  finalized: number
  /** Runs failed `stalled` (instance missing past the hard-stall deadline). */
  stalled: number
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
}: SweepDeps): Promise<SweepResult> {
  const now = clock.now()
  const stale = await agentRunRepository.listStale(now - leaseMs)
  let redriven = 0
  let finalized = 0
  let stalled = 0
  // Which runs were observed still-orphaned (`missing`) THIS tick — used to prune the
  // per-process clock of any run that recovered or went terminal so its deadline restarts
  // if it ever stalls again.
  const stillOrphaned = new Set<string>()
  for (const ref of stale) {
    const state = await instanceState(ref)
    if (state === 'alive') {
      orphanedSince.delete(ref.id)
      continue
    }
    if (state === 'terminal') {
      orphanedSince.delete(ref.id)
      await finalizeOrphan(ref)
      finalized++
      continue
    }
    // `missing`: the instance was lost (eviction, a missed event) and can be re-created.
    // Start (or carry forward) this run's per-process orphaned clock so the hard-stall
    // deadline below measures time-observed-orphaned, not raw lease age — a run first seen
    // orphaned this tick (e.g. right after a long cron outage) is always re-driven at least
    // once before it can ever be given up on.
    const firstSeenOrphaned = orphanedSince.get(ref.id) ?? now
    orphanedSince.set(ref.id, firstSeenOrphaned)
    stillOrphaned.add(ref.id)
    // An execution stuck `missing` past the hard deadline (re-driving isn't resurrecting it)
    // is failed `stalled` so it stops showing `running` forever and surfaces the failure
    // banner + retry.
    if (ref.kind === 'execution' && now - firstSeenOrphaned > hardStallMs) {
      await failStalled(ref)
      stalled++
      orphanedSince.delete(ref.id)
      stillOrphaned.delete(ref.id)
      continue
    }
    await redrive(ref)
    redriven++
  }
  // Forget runs that recovered (bumped their lease → left the stale set) or went terminal, so
  // their per-process orphaned clock restarts if they ever stall again.
  for (const id of orphanedSince.keys()) {
    if (!stillOrphaned.has(id)) orphanedSince.delete(id)
  }
  return { redriven, finalized, stalled }
}
