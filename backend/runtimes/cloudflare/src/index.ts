import type { ExecutionContext, MessageBatch, ScheduledController } from '@cloudflare/workers-types'
import { createApp } from './app'
import { loadConfig } from './infrastructure/config'
import type { Env, ExecutionStartMessage, GitHubSyncMessage } from './infrastructure/env'
import { requireTelemetryDb } from './infrastructure/env'
import { D1AgentRunRepository } from './infrastructure/repositories/D1AgentRunRepository'
import { D1CommitProjectionRepository } from './infrastructure/repositories/D1CommitProjectionRepository'
import { D1LiveContainerRepository } from './infrastructure/repositories/D1LiveContainerRepository'
import { D1SubscriptionActivationRepository } from './infrastructure/repositories/D1PersonalSubscriptionRepository'
import { ContainerInstanceRegistry } from './infrastructure/containers/ContainerInstanceRegistry'
import { D1RateLimitRepository } from './infrastructure/repositories/D1RateLimitRepository'
import { D1TokenUsageRepository } from './infrastructure/repositories/D1TokenUsageRepository'
import { D1LlmCallMetricRepository } from './infrastructure/repositories/D1LlmCallMetricRepository'
import { D1AgentContextSnapshotRepository } from './infrastructure/repositories/D1AgentContextSnapshotRepository'
import { D1AgentSearchQueryRepository } from './infrastructure/repositories/D1AgentSearchQueryRepository'
import { D1ProvisioningLogRepository } from './infrastructure/repositories/D1ProvisioningLogRepository'
import { D1PipelineScheduleRepository } from './infrastructure/repositories/D1PipelineScheduleRepository'
import { D1SubscriptionQuotaCycleRepository } from './infrastructure/repositories/D1SubscriptionQuotaCycleRepository'
import { D1PasswordResetTokenRepository } from './infrastructure/repositories/D1PasswordResetTokenRepository'
import { D1NotificationRepository } from './infrastructure/repositories/D1NotificationRepository'
import { buildContainer, buildCloudflareArtifactStoreResolver } from './infrastructure/container'
import {
  GITHUB_RECONCILE_STALE_MS,
  escalateStaleNotifications,
  sweepPlatformHealth,
} from '@cat-factory/server'
import { CryptoIdGenerator, SystemClock } from './infrastructure/runtime'
import { WorkflowsWorkRunner } from './infrastructure/workflows/WorkflowsWorkRunner'
import { WorkflowsBootstrapRunner } from './infrastructure/workflows/WorkflowsBootstrapRunner'
import { WorkflowsEnvConfigRepairRunner } from './infrastructure/workflows/WorkflowsEnvConfigRepairRunner'
import { sweepRetention } from './infrastructure/workflows/retention'
import {
  WorkflowsLookup,
  sweepStuckEnvTests,
  sweepStuckRuns,
} from './infrastructure/workflows/sweeper'
import { WorkflowsEnvironmentTestRunner } from './infrastructure/workflows/WorkflowsEnvironmentTestRunner'
import { D1EnvironmentTestRunRepository } from './infrastructure/repositories/D1EnvironmentTestRunRepository'
import { handleGitHubSyncBatch, reconcileStaleRepos } from './infrastructure/github/sync-consumer'
import { sweepExpiredEnvironments } from './infrastructure/environments/sweep'
import { logger } from './infrastructure/observability/logger'
import { runPlatformMetricsSweep } from './infrastructure/observability/platformMetrics'
import {
  defaultStepResolverRegistry,
  sweepBinaryArtifactRetention,
  validateRegistrationsOnce,
} from '@cat-factory/orchestration'
import { defaultAgentKindRegistry, defaultInitiativePresetRegistry } from '@cat-factory/agents'
import { gateRegistryWithBuiltins } from '@cat-factory/gates'
import { DEFAULT_WORKSPACE_SETTINGS } from '@cat-factory/kernel'
import { D1WorkspaceRepository } from './infrastructure/repositories/D1WorkspaceRepository'
import { D1WorkspaceSettingsRepository } from './infrastructure/repositories/D1WorkspaceSettingsRepository'

// Cloudflare Worker entry. In addition to the Hono `fetch` handler, we expose a
// `scheduled` handler (the cron sweeper, now also reconciling GitHub
// projections) and a `queue` consumer that multiplexes two queues: durable run
// admission and GitHub sync. The Workflows bindings require their entrypoint
// classes to be exported by name.
export { ExecutionWorkflow } from './infrastructure/workflows/ExecutionWorkflow'
export { GitHubBackfillWorkflow } from './infrastructure/workflows/GitHubBackfillWorkflow'
export { BootstrapWorkflow } from './infrastructure/workflows/BootstrapWorkflow'
export { EnvironmentTestWorkflow } from './infrastructure/workflows/EnvironmentTestWorkflow'
export { EnvConfigRepairWorkflow } from './infrastructure/workflows/EnvConfigRepairWorkflow'
// Container-enabled Durable Object backing per-run implementation containers.
export { ExecutionContainer } from './infrastructure/containers/ExecutionContainer'
// Container-enabled Durable Object backing per-run DEPLOY containers (the deploy-harness
// image: real kubectl/kustomize/helm — the `image: 'deploy'` dispatch variant).
export { DeployContainer } from './infrastructure/containers/DeployContainer'
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

// Installation-level extension point for custom agent kinds (alongside registerModelRegistry
// above): a deployment news a `defaultAgentKindRegistry()`, registers its own kinds on it by
// reference, and injects it into `buildContainer`/`createApp` via the `agentKindRegistry`
// override — the app-owned DI seam that replaces the old module-global `registerAgentKind`
// side effect. Every prompt build + executor routing decision then reads that instance.
export {
  AgentKindRegistry,
  defaultAgentKindRegistry,
  type AgentKindDefinition,
} from '@cat-factory/agents'
// Installation-level extension point for custom initiative presets (the same DI seam as agent
// kinds): a deployment news a `defaultInitiativePresetRegistry()`, registers its own presets on it
// by reference, and injects it into `buildContainer`/`createApp` via the `initiativePresetRegistry`
// override — replacing the old module-global `registerInitiativePreset` side effect.
export { defaultInitiativePresetRegistry } from '@cat-factory/agents'
export { InitiativePresetRegistry, type InitiativePresetRegistration } from '@cat-factory/kernel'
export { registerPipeline, registerPipelines, clearRegisteredPipelines } from '@cat-factory/kernel'
// The built-in model-preset ids + the catalog fallback default. A custom Worker entry that builds
// its own app can seed a different out-of-the-box default with
// `createApp({ overrides: { defaultModelPresetId: MODEL_PRESET_SEED_IDS.claude } })` (a
// `Partial<CoreDependencies>` field), parity with the Node/local `start()` seams.
export { DEFAULT_MODEL_PRESET_ID, MODEL_PRESET_SEED_IDS } from '@cat-factory/kernel'

// One app-owned agent-kind registry, shared by every per-request container (via the
// `createApp` override) AND the boot-time validation below — so the check validates the SAME
// instance the engine uses, matching the Node/local facades. A deployment injecting custom
// kinds registers them on this instance (or overrides it) before the first request.
const agentKindRegistry = defaultAgentKindRegistry()
// One app-owned initiative-preset registry, shared by every per-request container (via the
// `createApp` override). A deployment injecting custom presets registers them on this instance
// (or overrides it) before the first request — the same seam as `agentKindRegistry`.
const initiativePresetRegistry = defaultInitiativePresetRegistry()
// One app-owned gate registry with the built-in `@cat-factory/gates` suite installed, shared by
// every per-request container (via the `createApp` override) AND the boot-time validation below —
// so the check validates the SAME instance the engine uses. A deployment adds custom gates by
// registering them on this instance (or overrides it) before the first request.
const gateRegistry = gateRegistryWithBuiltins()
// One app-owned step-resolver registry (empty by default), shared the same way; a deployment
// registers its custom resolvers on this instance before the first request.
const stepResolverRegistry = defaultStepResolverRegistry()
const app = createApp({
  overrides: { agentKindRegistry, gateRegistry, stepResolverRegistry, initiativePresetRegistry },
})

/** Compact, log-friendly shape for an unknown caught value. */
function errInfo(error: unknown): { message: string; stack?: string } {
  if (error instanceof Error) {
    return { message: error.message, ...(error.stack ? { stack: error.stack } : {}) }
  }
  return { message: String(error) }
}

/** A run is treated as orphaned if its lease is older than this. */
const SWEEP_LEASE_MS = 5 * 60 * 1000
/** An execution whose instance stays missing this long is failed `stalled`, not re-driven. */
const SWEEP_HARD_STALL_MS = 60 * 60 * 1000
/**
 * Per-isolate "first observed orphaned" clock for the run sweeper (see `sweepStuckRuns`).
 * Keyed by run id, it makes the hard-stall deadline measure time-OBSERVED-orphaned rather
 * than raw lease age, so a cron outage / deploy freeze longer than `SWEEP_HARD_STALL_MS`
 * doesn't wrongly fail a recoverable run on the first post-outage tick. A warm isolate carries
 * it across the 2-min cron ticks; an isolate eviction just resets the clock (the safe
 * direction — more re-drive grace, never a premature kill). Mirrors the Node sweeper's
 * per-process `orphanedSince` map.
 */
const runSweepOrphanedSince = new Map<string, number>()
/** A `running` Kaizen grading older than this is re-driven (its sweep crashed mid-flight). */
const KAIZEN_STALE_MS = 10 * 60 * 1000
/** Max Kaizen gradings to run per scheduled pass (each is an LLM call; keep the batch small). */
const KAIZEN_SWEEP_BATCH = 5
/**
 * In-isolate re-entrancy guard for the Kaizen sweep (the analogue of the Node sweeper's
 * `running` flag). A batch of LLM gradings can outlast the 2-min cron interval, and a warm
 * isolate can have the next cron fire while the previous `waitUntil` is still in flight;
 * skipping an overlapping pass keeps two passes from racing the per-combo streak's
 * read-modify-write in `updateCombo` (the per-row `claim()` only serializes a single row).
 */
let kaizenSweeping = false

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
  // Validate the registered extensions (gates / agent kinds) ONCE, on the first request —
  // by which point every `register*` import side effect has run. A typo'd gate helperKind or
  // an unknown resultView then fails loudly at boot instead of mid-run. The once-guard keeps
  // it off the hot path (the Worker rebuilds its container per request, but this never re-runs).
  fetch(request: Request, env: Env, ctx: ExecutionContext) {
    validateRegistrationsOnce({
      agentKindRegistry,
      gateRegistry,
      onWarn: (problem) => logger.warn({ code: problem.code }, problem.message),
    })
    return app.fetch(request, env, ctx)
  },

  async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    const clock = new SystemClock()

    // Daily pass: prune the unbounded ledgers/projections to their retention
    // windows. The tables exist regardless of whether GitHub/agents are
    // configured, so this runs unconditionally; an unused table reclaims nothing.
    if (controller.cron === RETENTION_CRON) {
      // This branch never calls buildContainer (no request container is built for the
      // sweep), so do the same fail-fast the build does: a clear error beats an opaque
      // NPE deep in a telemetry repo when the binding is unbound.
      const telemetryDb = requireTelemetryDb(env)
      ctx.waitUntil(
        sweepRetention({
          tokenUsageRepository: new D1TokenUsageRepository({ db: env.DB }),
          rateLimitRepository: new D1RateLimitRepository({
            db: env.DB,
            idGenerator: new CryptoIdGenerator(),
          }),
          commitRepository: new D1CommitProjectionRepository({ db: env.DB }),
          // Telemetry tables live in the dedicated TELEMETRY_DB database.
          llmCallMetricRepository: new D1LlmCallMetricRepository({ db: telemetryDb }),
          agentContextSnapshotRepository: new D1AgentContextSnapshotRepository({
            db: telemetryDb,
          }),
          agentSearchQueryRepository: new D1AgentSearchQueryRepository({ db: telemetryDb }),
          // Modeled subscription quota-cycle counters live in the main DB (migration 0047).
          subscriptionQuotaCycleRepository: new D1SubscriptionQuotaCycleRepository({ db: env.DB }),
          pipelineScheduleRepository: new D1PipelineScheduleRepository({ db: env.DB }),
          passwordResetTokenRepository: new D1PasswordResetTokenRepository({ db: env.DB }),
          notificationRepository: new D1NotificationRepository({ db: env.DB }),
          // Prune the separate provisioning-log database when its binding is present.
          ...(env.PROVISIONING_DB
            ? {
                provisioningLogRepository: new D1ProvisioningLogRepository({
                  db: env.PROVISIONING_DB,
                }),
              }
            : {}),
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
      // Binary-artifact retention (UI screenshots + reference designs) is per-workspace, and
      // the blob backend is per-account (R2 or S3), so it resolves each workspace's store. Run
      // whenever storage could be configured: the R2 default (ARTIFACT_BUCKET) OR a per-account
      // S3 backend (which needs the encryption key to unseal its credentials).
      if (env.ARTIFACT_BUCKET || env.ENCRYPTION_KEY) {
        const settingsRepo = new D1WorkspaceSettingsRepository({ db: env.DB })
        ctx.waitUntil(
          sweepBinaryArtifactRetention({
            resolveStore: buildCloudflareArtifactStoreResolver(
              env,
              env.DB,
              clock,
              new CryptoIdGenerator(),
            ),
            listWorkspaceIds: () =>
              new D1WorkspaceRepository({ db: env.DB })
                .listVisible(null)
                .then((ws) => ws.map((w) => w.id)),
            retentionDaysFor: (workspaceId) =>
              settingsRepo
                .get(workspaceId)
                .then(
                  (s) =>
                    s?.artifactRetentionDays ?? DEFAULT_WORKSPACE_SETTINGS.artifactRetentionDays,
                ),
            now: clock.now(),
          })
            .then((removed) =>
              logger.info(
                { cron: 'retention', binaryArtifacts: removed },
                'artifact retention sweep complete',
              ),
            )
            .catch((error) =>
              logger.error(
                { cron: 'retention', err: errInfo(error) },
                'artifact retention sweep failed',
              ),
            ),
        )
      }
      return
    }

    // Frequent pass (every 2 min): time-sensitive backstops.
    // Re-drive any agent run — execution OR bootstrap — whose Workflows instance
    // died. One sweep over the unified agent_runs table dispatches by kind.
    if (env.EXECUTION_WORKFLOW || env.BOOTSTRAP_WORKFLOW || env.ENV_CONFIG_REPAIR_WORKFLOW) {
      const execLookup = env.EXECUTION_WORKFLOW ? new WorkflowsLookup(env.EXECUTION_WORKFLOW) : null
      const bootLookup = env.BOOTSTRAP_WORKFLOW ? new WorkflowsLookup(env.BOOTSTRAP_WORKFLOW) : null
      const repairLookup = env.ENV_CONFIG_REPAIR_WORKFLOW
        ? new WorkflowsLookup(env.ENV_CONFIG_REPAIR_WORKFLOW)
        : null
      const execRunner = env.EXECUTION_WORKFLOW
        ? new WorkflowsWorkRunner({ workflow: env.EXECUTION_WORKFLOW, queue: env.EXECUTION_QUEUE })
        : null
      const bootRunner = env.BOOTSTRAP_WORKFLOW
        ? new WorkflowsBootstrapRunner(env.BOOTSTRAP_WORKFLOW)
        : null
      const repairRunner = env.ENV_CONFIG_REPAIR_WORKFLOW
        ? new WorkflowsEnvConfigRepairRunner(env.ENV_CONFIG_REPAIR_WORKFLOW)
        : null
      ctx.waitUntil(
        sweepStuckRuns({
          agentRunRepository: new D1AgentRunRepository({ db: env.DB }),
          instanceState: (ref) => {
            const lookup =
              ref.kind === 'bootstrap'
                ? bootLookup
                : ref.kind === 'env-config-repair'
                  ? repairLookup
                  : execLookup
            // No binding for this kind → can't classify, so treat as alive (skip).
            return lookup ? lookup.instanceState(ref.id) : Promise.resolve('alive' as const)
          },
          redrive: async (ref) => {
            if (ref.kind === 'bootstrap') await bootRunner?.startRun(ref.workspaceId, ref.id)
            else if (ref.kind === 'env-config-repair')
              await repairRunner?.startRun(ref.workspaceId, ref.id)
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
            } else if (ref.kind === 'env-config-repair') {
              if (container.envConfigRepair) {
                await container.envConfigRepair.service.stop(ref.workspaceId, ref.id, {
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
          // An execution whose instance stays missing past this deadline is failed
          // `stalled` rather than re-created forever (symmetric with the Node sweeper).
          failStalled: async (ref) => {
            const container = buildContainer(env)
            await container.executionService.failRun(
              ref.workspaceId,
              ref.id,
              'Run stalled: its durable driver was lost and automatic recovery could not resume it.',
              'stalled',
              null,
            )
          },
          clock,
          leaseMs: SWEEP_LEASE_MS,
          hardStallMs: SWEEP_HARD_STALL_MS,
          orphanedSince: runSweepOrphanedSince,
        })
          // Surface what the sweep did — the key signal for "are runs getting stuck?"
          // Only log when it actually acted.
          .then(({ redriven, finalized, stalled }) => {
            if (redriven > 0 || finalized > 0 || stalled > 0) {
              logger.warn({ cron: 'run-sweeper', redriven, finalized, stalled }, 'swept stuck runs')
            }
          })
          .catch((error) =>
            logger.error({ cron: 'run-sweeper', err: errInfo(error) }, 'run sweep failed'),
          ),
      )
    }

    // Env-test self-tests live in their own table (not agent_runs), so the unified run
    // sweep above never sees them — this sibling sweep re-drives a run whose Workflows
    // instance was lost and finalizes (cleanup + failed) one whose instance is terminal.
    if (env.ENV_TEST_WORKFLOW) {
      const envTestLookup = new WorkflowsLookup(env.ENV_TEST_WORKFLOW)
      const envTestRunner = new WorkflowsEnvironmentTestRunner(env.ENV_TEST_WORKFLOW)
      ctx.waitUntil(
        sweepStuckEnvTests({
          repository: new D1EnvironmentTestRunRepository({ db: env.DB }),
          instanceState: (runId) => envTestLookup.instanceState(runId),
          redrive: (workspaceId, runId) => envTestRunner.startRun(workspaceId, runId),
          finalizeOrphan: async (workspaceId, runId) => {
            const container = buildContainer(env)
            await container.environments?.environmentTest?.expire(
              workspaceId,
              runId,
              'The environment test was stopped automatically: its durable driver ended without finalizing it.',
            )
          },
          clock,
          leaseMs: SWEEP_LEASE_MS,
        })
          .then(({ redriven, finalized }) => {
            if (redriven > 0 || finalized > 0) {
              logger.warn(
                { cron: 'env-test-sweeper', redriven, finalized },
                'swept stuck env-test runs',
              )
            }
          })
          .catch((error) =>
            logger.error(
              { cron: 'env-test-sweeper', err: errInfo(error) },
              'env-test sweep failed',
            ),
          ),
      )
    }

    // Reclaim expired personal-credential activations (individual-usage subscriptions).
    // Each is a short-lived, system-encrypted per-run copy of a user's token; the TTL
    // bounds standing exposure and a finished run's rows are deleted at completion, but
    // this backstop also clears any that outlived their TTL. The table always exists.
    {
      const activations = new D1SubscriptionActivationRepository({ db: env.DB })
      ctx.waitUntil(
        activations
          .deleteExpired(clock.now())
          .then((reclaimed) => {
            if (reclaimed > 0)
              logger.info({ cron: 'activation-sweeper', reclaimed }, 'reclaimed activations')
          })
          .catch((error) =>
            logger.error(
              { cron: 'activation-sweeper', err: errInfo(error) },
              'activation sweep failed',
            ),
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

    // Escalate long-waiting notifications yellow → red (every 2 min). Runs no longer
    // time out waiting for a human, so the escalating notification — past each
    // workspace's `waitingEscalationMinutes` threshold — is the overdue-human signal.
    ctx.waitUntil(
      escalateStaleNotifications(buildContainer(env), clock.now())
        .then((escalated) => {
          if (escalated > 0)
            logger.info({ cron: 'notification-escalation', escalated }, 'escalated notifications')
        })
        .catch((error) =>
          logger.error(
            { cron: 'notification-escalation', err: errInfo(error) },
            'notification escalation failed',
          ),
        ),
    )

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

    // Tick the initiative execution loop (every 2 min): reconcile each executing initiative's
    // spawned tasks and spawn the next wave up to its concurrency cap. Terminal child runs poke
    // the loop directly, so this is the backstop cadence. No-op when initiatives aren't wired.
    ctx.waitUntil(
      Promise.resolve(buildContainer(env).initiatives?.loop.runDue(clock.now()))
        .then((result) => {
          if (result && (result.spawned > 0 || result.completed > 0)) {
            logger.info({ cron: 'initiative-loop', ...result }, 'ticked initiative loop')
          }
        })
        .catch((error) =>
          logger.error(
            { cron: 'initiative-loop', err: errInfo(error) },
            'initiative-loop sweep failed',
          ),
        ),
    )

    // Run any pending Kaizen gradings (every 2 min): the engine only inserts `scheduled`
    // rows at run completion, so this background pass does the actual LLM grading (and
    // re-drives `running` rows orphaned by a crashed sweep). Bounded per pass to stay
    // within the cron budget; no-op when the Kaizen feature isn't wired. The grader's
    // model is resolved per-workspace (Model Configuration), so this is workspace-wide.
    if (!kaizenSweeping) {
      kaizenSweeping = true
      ctx.waitUntil(
        Promise.resolve(
          buildContainer(env).kaizen?.service.runPending(
            clock.now() - KAIZEN_STALE_MS,
            KAIZEN_SWEEP_BATCH,
          ),
        )
          .then((processed) => {
            if (processed && processed > 0)
              logger.info({ cron: 'kaizen-sweeper', processed }, 'ran pending kaizen gradings')
          })
          .catch((error) =>
            logger.error({ cron: 'kaizen-sweeper', err: errInfo(error) }, 'kaizen sweep failed'),
          )
          .finally(() => {
            kaizenSweeping = false
          }),
      )
    }

    // Reconcile GitHub projections that may have missed a webhook (no-op unless
    // the integration is configured).
    ctx.waitUntil(
      reconcileStaleRepos(env, clock, GITHUB_RECONCILE_STALE_MS)
        .then((scheduled) => {
          if (scheduled > 0)
            // `sweep:` (not `cron:`) so the summary shares a field with the pass's
            // per-repo lines, which the shared reconcile core emits on both facades.
            logger.info({ sweep: 'github-reconcile', scheduled }, 'scheduled repo resyncs')
        })
        .catch((error) =>
          logger.error(
            { sweep: 'github-reconcile', err: errInfo(error) },
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

    // Push deployment-level (platform-operator) observability aggregates to the OTLP
    // endpoint as OpenTelemetry gauge metrics, once per cron tick. Opt-in on top of the base
    // OTel exporter (OTEL_PLATFORM_METRICS); a no-op otherwise. Per account, enumerated from
    // the workspace projection — the same `listVisible(null)` shape the artifact sweep uses.
    // The container (hence the platform-observability read) is built only when opted in.
    {
      const otel = loadConfig(env).otel
      const sweep = runPlatformMetricsSweep({
        otel,
        platformObservability: otel.platformMetrics.enabled
          ? buildContainer(env).platformObservability
          : undefined,
        workspaceRepository: new D1WorkspaceRepository({ db: env.DB }),
        logger,
      })
      if (sweep) ctx.waitUntil(sweep)
    }

    // Raise/clear `platform_health` notifications when the deployment's OWN run health crosses
    // an operator threshold, per account (the push counterpart to the operator dashboard read).
    // Opt-in (`PLATFORM_ALERTS`); the container (hence the platform-observability read) is built
    // only when opted in so a deployment that hasn't opted in pays nothing.
    if (loadConfig(env).platformAlerts.enabled) {
      ctx.waitUntil(
        sweepPlatformHealth(buildContainer(env), logger)
          .then(({ raised, cleared }) => {
            if (raised > 0 || cleared > 0)
              logger.info({ cron: 'platform-health', raised, cleared }, 'platform health sweep')
          })
          .catch((error) =>
            logger.error(
              { cron: 'platform-health', err: errInfo(error) },
              'platform health sweep failed',
            ),
          ),
      )
    }
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
