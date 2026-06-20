import type { ExecutionContext, MessageBatch, ScheduledController } from '@cloudflare/workers-types'
import { createApp } from './app'
import { loadConfig } from './infrastructure/config'
import type { Env, ExecutionStartMessage, GitHubSyncMessage } from './infrastructure/env'
import { D1AgentRunRepository } from './infrastructure/repositories/D1AgentRunRepository'
import { D1CommitProjectionRepository } from './infrastructure/repositories/D1CommitProjectionRepository'
import { D1LiveContainerRepository } from './infrastructure/repositories/D1LiveContainerRepository'
import { ContainerInstanceRegistry } from './infrastructure/containers/ContainerInstanceRegistry'
import { D1RateLimitRepository } from './infrastructure/repositories/D1RateLimitRepository'
import { D1TokenUsageRepository } from './infrastructure/repositories/D1TokenUsageRepository'
import { D1LlmCallMetricRepository } from './infrastructure/repositories/D1LlmCallMetricRepository'
import { D1PipelineScheduleRepository } from './infrastructure/repositories/D1PipelineScheduleRepository'
import { buildContainer } from './infrastructure/container'
import { CryptoIdGenerator, SystemClock } from './infrastructure/runtime'
import { WorkflowsWorkRunner } from './infrastructure/workflows/WorkflowsWorkRunner'
import { WorkflowsBootstrapRunner } from './infrastructure/workflows/WorkflowsBootstrapRunner'
import { sweepRetention } from './infrastructure/workflows/retention'
import { WorkflowsLookup, sweepStuckRuns } from './infrastructure/workflows/sweeper'
import { handleGitHubSyncBatch, reconcileStaleRepos } from './infrastructure/github/sync-consumer'
import { sweepExpiredEnvironments } from './infrastructure/environments/sweep'
import { logger } from './infrastructure/observability/logger'

// Cloudflare Worker entry. In addition to the Hono `fetch` handler, we expose a
// `scheduled` handler (the cron sweeper, now also reconciling GitHub
// projections) and a `queue` consumer that multiplexes two queues: durable run
// admission and GitHub sync. The Workflows bindings require their entrypoint
// classes to be exported by name.
export { ExecutionWorkflow } from './infrastructure/workflows/ExecutionWorkflow'
export { GitHubBackfillWorkflow } from './infrastructure/workflows/GitHubBackfillWorkflow'
export { BootstrapWorkflow } from './infrastructure/workflows/BootstrapWorkflow'
// Container-enabled Durable Object backing per-run implementation containers.
export { ExecutionContainer } from './infrastructure/containers/ExecutionContainer'
// Per-workspace WebSocket fan-out hub (real-time execution/board events).
export { WorkspaceEventsHub } from './infrastructure/durable-objects/WorkspaceEventsHub'

// Installation-level AI provisioning extension point: a deployment registers extra
// model-provider registries at startup (e.g. AWS Bedrock from
// @cat-factory/provider-bedrock) and every container build picks them up.
export {
  registerModelRegistry,
  clearModelRegistries,
  type ModelRegistryFactory,
} from './infrastructure/ai/registries'

const app = createApp()

/** Compact, log-friendly shape for an unknown caught value. */
function errInfo(error: unknown): { message: string; stack?: string } {
  if (error instanceof Error) {
    return { message: error.message, ...(error.stack ? { stack: error.stack } : {}) }
  }
  return { message: String(error) }
}

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
          llmCallMetricRepository: new D1LlmCallMetricRepository({ db: env.DB }),
          pipelineScheduleRepository: new D1PipelineScheduleRepository({ db: env.DB }),
          clock,
          policy: loadConfig(env).retention,
        })
          .then((result) =>
            logger.info({ cron: 'retention', ...result }, 'retention sweep complete'),
          )
          .catch((error) =>
            logger.error({ cron: 'retention', err: errInfo(error) }, 'retention sweep failed'),
          ),
      )
      return
    }

    // Frequent pass (every 2 min): time-sensitive backstops.
    // Re-drive any agent run — execution OR bootstrap — whose Workflows instance
    // died. One sweep over the unified agent_runs table dispatches by kind.
    if (env.EXECUTION_WORKFLOW || env.BOOTSTRAP_WORKFLOW) {
      const execLookup = env.EXECUTION_WORKFLOW ? new WorkflowsLookup(env.EXECUTION_WORKFLOW) : null
      const bootLookup = env.BOOTSTRAP_WORKFLOW ? new WorkflowsLookup(env.BOOTSTRAP_WORKFLOW) : null
      const execRunner = env.EXECUTION_WORKFLOW
        ? new WorkflowsWorkRunner({ workflow: env.EXECUTION_WORKFLOW, queue: env.EXECUTION_QUEUE })
        : null
      const bootRunner = env.BOOTSTRAP_WORKFLOW
        ? new WorkflowsBootstrapRunner(env.BOOTSTRAP_WORKFLOW)
        : null
      ctx.waitUntil(
        sweepStuckRuns({
          agentRunRepository: new D1AgentRunRepository({ db: env.DB }),
          instanceState: (ref) => {
            const lookup = ref.kind === 'bootstrap' ? bootLookup : execLookup
            // No binding for this kind → can't classify, so treat as alive (skip).
            return lookup ? lookup.instanceState(ref.id) : Promise.resolve('alive' as const)
          },
          redrive: async (ref) => {
            if (ref.kind === 'bootstrap') await bootRunner?.startRun(ref.workspaceId, ref.id)
            else await execRunner?.startRun(ref.workspaceId, ref.id)
          },
          // The durable instance is terminal and can't be recreated → finalize the
          // run as stopped so it stops showing `running` forever (also reclaims any
          // leftover container). Reuses the same stop path the user-facing button hits.
          finalizeOrphan: async (ref) => {
            const container = buildContainer(env)
            const reason =
              'The run was stopped automatically: its durable driver ended without finalizing it.'
            if (ref.kind === 'bootstrap') {
              if (container.bootstrap) {
                await container.bootstrap.service.stop(ref.workspaceId, ref.id, {
                  reason,
                  kind: 'unknown',
                })
              }
            } else {
              await container.executionService.stopRun(ref.workspaceId, ref.id, {
                reason,
                kind: 'unknown',
              })
            }
          },
          clock,
          leaseMs: SWEEP_LEASE_MS,
        })
          // Surface what the sweep did — the key signal for "are runs getting stuck?"
          // Only log when it actually acted.
          .then(({ redriven, finalized }) => {
            if (redriven > 0 || finalized > 0) {
              logger.warn({ cron: 'run-sweeper', redriven, finalized }, 'swept stuck runs')
            }
          })
          .catch((error) =>
            logger.error({ cron: 'run-sweeper', err: errInfo(error) }, 'run sweep failed'),
          ),
      )
    }

    // Instance-level container reaper: kill any per-run container that outlived its
    // legitimate maximum lifetime. This is the load-bearing backstop the run-record
    // nets miss — a terminal run whose container survived, or a stuck-`running` run
    // a live driver keeps warm (so its idle sleep clock never starts). Keys off the
    // real live-container inventory, not the run record, and kills via the same
    // EXEC_CONTAINER binding (no Cloudflare API token). With normal runs now self-
    // reclaiming, a reaped container is a genuine leak — the registry logs each loudly.
    if (env.EXEC_CONTAINER) {
      const reaper = new ContainerInstanceRegistry(
        env.EXEC_CONTAINER,
        new D1LiveContainerRepository({ db: env.DB }),
        clock,
      )
      const maxAgeMs = loadConfig(env).execution.containerMaxAgeMs
      ctx.waitUntil(
        reaper
          .reapStaleBefore(clock.now() - maxAgeMs)
          .then(({ reaped }) => {
            if (reaped > 0)
              logger.warn({ cron: 'container-reaper', reaped }, 'reaped leaked containers')
          })
          .catch((error) =>
            logger.error(
              { cron: 'container-reaper', err: errInfo(error) },
              'container reap failed',
            ),
          ),
      )
    }

    // Fire any due recurring pipelines (every 2 min; the actual cadence is hours).
    // Each due schedule starts its pipeline against its reused block, skipping any
    // whose block already has an active run. No-op when the feature isn't wired.
    ctx.waitUntil(
      Promise.resolve(buildContainer(env).recurring?.service.runDue(clock.now()))
        .then((result) => {
          if (result && (result.fired > 0 || result.skipped > 0)) {
            logger.info({ cron: 'recurring-pipelines', ...result }, 'fired recurring pipelines')
          }
        })
        .catch((error) =>
          logger.error(
            { cron: 'recurring-pipelines', err: errInfo(error) },
            'recurring-pipeline sweep failed',
          ),
        ),
    )

    // Reconcile GitHub projections that may have missed a webhook (no-op unless
    // the integration is configured).
    ctx.waitUntil(
      reconcileStaleRepos(env, clock, GITHUB_RECONCILE_STALE_MS)
        .then((scheduled) => {
          if (scheduled > 0)
            logger.info({ cron: 'github-reconcile', scheduled }, 'scheduled repo resyncs')
        })
        .catch((error) =>
          logger.error(
            { cron: 'github-reconcile', err: errInfo(error) },
            'github reconcile failed',
          ),
        ),
    )

    // Tear down ephemeral environments whose TTL has elapsed (no-op unless the
    // environment integration is configured).
    ctx.waitUntil(
      sweepExpiredEnvironments(env, clock).catch((error) =>
        logger.error({ cron: 'env-sweeper', err: errInfo(error) }, 'environment sweep failed'),
      ),
    )
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
