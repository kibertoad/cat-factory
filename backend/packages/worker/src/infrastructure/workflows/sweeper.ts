import type { Clock, ExecutionRepository, WorkRunner } from '@cat-factory/core'
import type { Workflow } from '@cloudflare/workers-types'

/** Tells the sweeper whether a run's durable instance is still alive. */
export interface WorkflowLookup {
  isAlive(executionId: string): Promise<boolean>
}

/** WorkflowLookup over a Cloudflare Workflows binding. */
export class WorkflowsLookup implements WorkflowLookup {
  constructor(private readonly workflow: Workflow) {}

  async isAlive(executionId: string): Promise<boolean> {
    try {
      const instance = await this.workflow.get(executionId)
      const { status } = await instance.status()
      // Running/queued/paused/waiting count as alive; terminal states do not.
      return status === 'running' || status === 'queued' || status === 'waiting' ||
        status === 'paused'
    } catch {
      // No such instance → not alive (needs re-driving).
      return false
    }
  }
}

export interface SweepDeps {
  executionRepository: ExecutionRepository
  workflowLookup: WorkflowLookup
  workRunner: WorkRunner
  clock: Clock
  /** A run is considered stuck if its lease is older than this many ms. */
  leaseMs: number
}

/**
 * Backstop for runs that are still `running` in storage but whose Workflows
 * instance has died (eviction, a missed event, an infra blip). Cron invokes
 * this; it re-drives each orphan via the (idempotent) WorkRunner. Returns the
 * number of runs it re-drove, for logging. Pure orchestration over its ports so
 * it is unit-testable with fakes.
 */
export async function sweepStuckRuns({
  executionRepository,
  workflowLookup,
  workRunner,
  clock,
  leaseMs,
}: SweepDeps): Promise<number> {
  const stale = await executionRepository.listStale(clock.now() - leaseMs)
  let redriven = 0
  for (const run of stale) {
    if (await workflowLookup.isAlive(run.id)) continue
    await workRunner.startRun(run.workspaceId, run.id)
    redriven++
  }
  return redriven
}
