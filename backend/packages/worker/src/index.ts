import type { ExecutionContext, MessageBatch, ScheduledController } from '@cloudflare/workers-types'
import { createApp } from './app'
import { loadConfig } from './infrastructure/config'
import type { Env, ExecutionStartMessage, GitHubSyncMessage } from './infrastructure/env'
import { D1CommitProjectionRepository } from './infrastructure/repositories/D1CommitProjectionRepository'
import { D1ExecutionRepository } from './infrastructure/repositories/D1ExecutionRepository'
import { D1RateLimitRepository } from './infrastructure/repositories/D1RateLimitRepository'
import { D1TokenUsageRepository } from './infrastructure/repositories/D1TokenUsageRepository'
import { CryptoIdGenerator, SystemClock } from './infrastructure/runtime'
import { WorkflowsWorkRunner } from './infrastructure/workflows/WorkflowsWorkRunner'
import { sweepRetention } from './infrastructure/workflows/retention'
import { WorkflowsLookup, sweepStuckRuns } from './infrastructure/workflows/sweeper'
import { handleGitHubSyncBatch, reconcileStaleRepos } from './infrastructure/github/sync-consumer'
import { sweepExpiredEnvironments } from './infrastructure/environments/sweep'

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

/**
 * Cron schedule (see wrangler.toml `triggers.crons`) that drives the retention
 * sweep. Retention windows are days-to-months long, so a daily pass is plenty —
 * running it on the 2-min run-sweeper cron would just re-issue the same boundary
 * DELETEs ~720×/day against the single D1 writer. Routed by `controller.cron`.
 */
const RETENTION_CRON = '0 3 * * *'

export default {
  fetch: app.fetch,

  async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    const clock = new SystemClock()

    // Daily pass: prune the unbounded ledgers/projections to their retention
    // windows. The tables exist regardless of whether GitHub/agents are
    // configured, so this runs unconditionally; an unused table reclaims nothing.
    if (controller.cron === RETENTION_CRON) {
      ctx.waitUntil(
        sweepRetention({
          tokenUsageRepository: new D1TokenUsageRepository({ db: env.DB }),
          rateLimitRepository: new D1RateLimitRepository({
            db: env.DB,
            idGenerator: new CryptoIdGenerator(),
          }),
          commitRepository: new D1CommitProjectionRepository({ db: env.DB }),
          clock,
          policy: loadConfig(env).retention,
        }).then(() => undefined),
      )
      return
    }

    // Frequent pass (every 2 min): time-sensitive backstops.
    // Re-drive durable runs whose Workflows instance died.
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

    // Tear down ephemeral environments whose TTL has elapsed (no-op unless the
    // environment integration is configured).
    ctx.waitUntil(sweepExpiredEnvironments(env, clock).then(() => undefined))
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
