import type { AgentRunRef, AgentRunRepository, Clock } from '@cat-factory/core'
import type { Workflow } from '@cloudflare/workers-types'

/** Tells the sweeper whether a run's durable instance is still alive. */
export interface WorkflowLookup {
  isAlive(runId: string): Promise<boolean>
}

/** WorkflowLookup over a Cloudflare Workflows binding. */
export class WorkflowsLookup implements WorkflowLookup {
  constructor(private readonly workflow: Workflow) {}

  async isAlive(runId: string): Promise<boolean> {
    try {
      const instance = await this.workflow.get(runId)
      const { status } = await instance.status()
      // Running/queued/paused/waiting count as alive; terminal states do not.
      return (
        status === 'running' || status === 'queued' || status === 'waiting' || status === 'paused'
      )
    } catch {
      // No such instance → not alive (needs re-driving).
      return false
    }
  }
}

export interface SweepDeps {
  agentRunRepository: AgentRunRepository
  /** Whether the durable instance backing this run is still alive (by kind). */
  isAlive(ref: AgentRunRef): Promise<boolean>
  /** Re-create the durable driver for this run (idempotent), routed by kind. */
  redrive(ref: AgentRunRef): Promise<void>
  clock: Clock
  /** A run is considered stuck if its lease is older than this many ms. */
  leaseMs: number
}

/**
 * Backstop for runs that are still `running` in storage but whose Workflows
 * instance has died (eviction, a missed event, an infra blip). Cron invokes this;
 * it re-drives each orphan via the (idempotent) `redrive` callback. Spans BOTH
 * agent flows — execution and bootstrap — so a dead bootstrap workflow is now
 * re-driven too (previously only the browser reconnect recovered it). Returns the
 * number of runs it re-drove, for logging. Pure orchestration over its ports so it
 * is unit-testable with fakes.
 */
export async function sweepStuckRuns({
  agentRunRepository,
  isAlive,
  redrive,
  clock,
  leaseMs,
}: SweepDeps): Promise<number> {
  const stale = await agentRunRepository.listStale(clock.now() - leaseMs)
  let redriven = 0
  for (const ref of stale) {
    if (await isAlive(ref)) continue
    await redrive(ref)
    redriven++
  }
  return redriven
}
