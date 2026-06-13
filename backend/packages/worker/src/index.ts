import type {
  ExecutionContext,
  MessageBatch,
  ScheduledController,
} from '@cloudflare/workers-types'
import { createApp } from './app'
import type { Env, ExecutionStartMessage } from './infrastructure/env'
import { D1ExecutionRepository } from './infrastructure/repositories/D1ExecutionRepository'
import { SystemClock } from './infrastructure/runtime'
import { WorkflowsWorkRunner } from './infrastructure/workflows/WorkflowsWorkRunner'
import { WorkflowsLookup, sweepStuckRuns } from './infrastructure/workflows/sweeper'

// Cloudflare Worker entry. In addition to the Hono `fetch` handler, we expose a
// `scheduled` handler (the cron sweeper that recovers orphaned runs) and a
// `queue` consumer (admission gate that creates Workflows instances). The
// Workflows binding also requires the entrypoint class to be exported by name.
export { ExecutionWorkflow } from './infrastructure/workflows/ExecutionWorkflow'

const app = createApp()

/** A run is treated as orphaned if its lease is older than this. */
const SWEEP_LEASE_MS = 5 * 60 * 1000

export default {
  fetch: app.fetch,

  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    if (!env.EXECUTION_WORKFLOW) return
    const workflow = env.EXECUTION_WORKFLOW
    const clock = new SystemClock()
    ctx.waitUntil(
      sweepStuckRuns({
        executionRepository: new D1ExecutionRepository({ db: env.DB, clock }),
        workflowLookup: new WorkflowsLookup(workflow),
        workRunner: new WorkflowsWorkRunner({ workflow, queue: env.EXECUTION_QUEUE }),
        clock,
        leaseMs: SWEEP_LEASE_MS,
      }).then(() => undefined),
    )
  },

  async queue(batch: MessageBatch<ExecutionStartMessage>, env: Env): Promise<void> {
    if (!env.EXECUTION_WORKFLOW) {
      for (const message of batch.messages) message.ack()
      return
    }
    // Create the Workflows instance directly here (not via the queue again).
    const runner = new WorkflowsWorkRunner({ workflow: env.EXECUTION_WORKFLOW })
    for (const message of batch.messages) {
      try {
        await runner.create(message.body.workspaceId, message.body.executionId)
        message.ack()
      } catch {
        message.retry()
      }
    }
  },
}
