import type { ExecutionContext, MessageBatch, ScheduledController } from '@cloudflare/workers-types'
import { createApp } from './app'
import type { Env, ExecutionStartMessage, GitHubSyncMessage } from './infrastructure/env'
import { D1ExecutionRepository } from './infrastructure/repositories/D1ExecutionRepository'
import { SystemClock } from './infrastructure/runtime'
import { WorkflowsWorkRunner } from './infrastructure/workflows/WorkflowsWorkRunner'
import { WorkflowsLookup, sweepStuckRuns } from './infrastructure/workflows/sweeper'
import { handleGitHubSyncBatch, reconcileStaleRepos } from './infrastructure/github/sync-consumer'

// Cloudflare Worker entry. In addition to the Hono `fetch` handler, we expose a
// `scheduled` handler (the cron sweeper, now also reconciling GitHub
// projections) and a `queue` consumer that multiplexes two queues: durable run
// admission and GitHub sync. The Workflows bindings require their entrypoint
// classes to be exported by name.
export { ExecutionWorkflow } from './infrastructure/workflows/ExecutionWorkflow'
export { GitHubBackfillWorkflow } from './infrastructure/workflows/GitHubBackfillWorkflow'

const app = createApp()

/** A run is treated as orphaned if its lease is older than this. */
const SWEEP_LEASE_MS = 5 * 60 * 1000
/** A GitHub projection is reconciled if it hasn't synced within this window. */
const GITHUB_RECONCILE_STALE_MS = 30 * 60 * 1000

/** Queue name for GitHub webhook deliveries / resync jobs (see wrangler.toml). */
const GITHUB_SYNC_QUEUE_NAME = 'cat-factory-github-sync'

export default {
  fetch: app.fetch,

  async scheduled(
    _controller: ScheduledController,
    env: Env,
    ctx: ExecutionContext,
  ): Promise<void> {
    const clock = new SystemClock()

    // Backstop: re-drive durable runs whose Workflows instance died.
    if (env.EXECUTION_WORKFLOW) {
      const workflow = env.EXECUTION_WORKFLOW
      ctx.waitUntil(
        sweepStuckRuns({
          executionRepository: new D1ExecutionRepository({ db: env.DB, clock }),
          workflowLookup: new WorkflowsLookup(workflow),
          workRunner: new WorkflowsWorkRunner({ workflow, queue: env.EXECUTION_QUEUE }),
          clock,
          leaseMs: SWEEP_LEASE_MS,
        }).then(() => undefined),
      )
    }

    // Reconcile GitHub projections that may have missed a webhook (no-op unless
    // the integration is configured).
    ctx.waitUntil(reconcileStaleRepos(env, clock, GITHUB_RECONCILE_STALE_MS).then(() => undefined))
  },

  async queue(
    batch: MessageBatch<ExecutionStartMessage | GitHubSyncMessage>,
    env: Env,
  ): Promise<void> {
    // Route by source queue — the single handler serves both queues.
    if (batch.queue === GITHUB_SYNC_QUEUE_NAME) {
      await handleGitHubSyncBatch(batch as MessageBatch<GitHubSyncMessage>, env)
      return
    }

    // Execution admission queue: create the Workflows instance per message.
    if (!env.EXECUTION_WORKFLOW) {
      for (const message of batch.messages) message.ack()
      return
    }
    const runner = new WorkflowsWorkRunner({ workflow: env.EXECUTION_WORKFLOW })
    for (const message of batch.messages as MessageBatch<ExecutionStartMessage>['messages']) {
      try {
        await runner.create(message.body.workspaceId, message.body.executionId)
        message.ack()
      } catch {
        message.retry()
      }
    }
  },
}
