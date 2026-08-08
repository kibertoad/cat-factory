import type {
  ExecutionContext,
  ExportedHandler,
  MessageBatch,
  ScheduledController,
} from '@cloudflare/workers-types'
import { type CreateAppOptions, createApp } from './app'
import { loadConfig } from './infrastructure/config'
import type {
  Env,
  ExecutionStartMessage,
  GitHubSyncMessage,
  TrackerSyncMessage,
} from './infrastructure/env'
import { requireAuditDb, requireTelemetryDb } from './infrastructure/env'
import { D1AgentRunRepository } from './infrastructure/repositories/D1AgentRunRepository'
import { D1CommitProjectionRepository } from './infrastructure/repositories/D1CommitProjectionRepository'
import { D1LiveContainerRepository } from './infrastructure/repositories/D1LiveContainerRepository'
import { D1SubscriptionActivationRepository } from './infrastructure/repositories/D1PersonalSubscriptionRepository'
import { ContainerInstanceRegistry } from './infrastructure/containers/ContainerInstanceRegistry'
import { D1RateLimitRepository } from './infrastructure/repositories/D1RateLimitRepository'
import { D1TokenUsageRepository } from './infrastructure/repositories/D1TokenUsageRepository'
import { D1LlmCallMetricRepository } from './infrastructure/repositories/D1LlmCallMetricRepository'
import { D1AgentContextSnapshotRepository } from './infrastructure/repositories/D1AgentContextSnapshotRepository'
import { D1AgentToolCallRepository } from './infrastructure/repositories/D1AgentToolCallRepository'
import { D1AgentSearchQueryRepository } from './infrastructure/repositories/D1AgentSearchQueryRepository'
import { D1ProvisioningLogRepository } from './infrastructure/repositories/D1ProvisioningLogRepository'
import { D1PipelineScheduleRepository } from './infrastructure/repositories/D1PipelineScheduleRepository'
import { D1SubscriptionQuotaCycleRepository } from './infrastructure/repositories/D1SubscriptionQuotaCycleRepository'
import { D1AuthAttemptRepository } from './infrastructure/repositories/D1AuthAttemptRepository'
import { D1MachineNodeRepository } from './infrastructure/repositories/D1MachineNodeRepository'
import { D1PasswordResetTokenRepository } from './infrastructure/repositories/D1PasswordResetTokenRepository'
import { D1GateOutcomeRepository } from './infrastructure/repositories/D1GateOutcomeRepository'
import { D1NotificationRepository } from './infrastructure/repositories/D1NotificationRepository'
import { D1PlatformMetricsRepository } from './infrastructure/repositories/D1PlatformMetricsRepository'
import { D1AuditEventRepository } from './infrastructure/repositories/D1AuditEventRepository'
import { D1SpendRollupRepository } from './infrastructure/repositories/D1SpendRollupRepository'
import { buildContainer, buildCloudflareArtifactStoreResolver } from './infrastructure/container'
// The deployment's OWN document credentials, read from `env`. Shared with the per-request container
// build so the boot check and the engine agree about what this deployment can read.
import {
  deploymentDocumentDeps,
  deploymentDocumentProblems,
} from './infrastructure/container-documents-deps'
import {
  GITHUB_RECONCILE_STALE_MS,
  escalateStaleNotifications,
  FOUNDATIONAL_SOURCE_STALE_MS,
  shouldRunReachabilityPass,
  sweepFoundationalSources,
  sweepInfraReachability,
  sweepPlatformHealth,
  sweepSpendAlerts,
  SPEND_ALERT_INTERVAL_MS,
  operationalMetrics,
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
import {
  handleGitHubSyncBatch,
  handleTrackerSyncBatch,
  reconcileStaleRepos,
} from './infrastructure/github/sync-consumer'
import { sweepExpiredEnvironments } from './infrastructure/environments/sweep'
import { logger } from './infrastructure/observability/logger'
import { runWithExecutionContext } from './infrastructure/requestContext'
import { runPlatformMetricsSweep } from './infrastructure/observability/platformMetrics'
import { flushOperationalMetricsForIsolate } from './infrastructure/observability/operationalFlush'
import { flushOtelLogsForIsolate } from './infrastructure/observability/logExport'
import { applyLogSettings } from './infrastructure/observability/logSettings'
import { loadOtelConfig } from './infrastructure/config/otel'
import { SweepTick } from './infrastructure/observability/cronSweep'
import {
  type CoreDependencies,
  defaultJudgeRegistry,
  defaultStepResolverRegistry,
  sweepBinaryArtifactRetention,
  validateRegistrationsOnce,
} from '@cat-factory/orchestration'
import { promptFragmentRegistryWithBuiltins } from '@cat-factory/prompt-fragments'
import { defaultAgentKindRegistry, defaultInitiativePresetRegistry } from '@cat-factory/agents'
import { gateRegistryWithBuiltins } from '@cat-factory/gates'
import type { BinaryStoreRegistry } from '@cat-factory/kernel'
import {
  DEFAULT_WORKSPACE_SETTINGS,
  defaultBinaryGeneratorRegistry,
  defaultBinaryStoreRegistry,
  defaultFoundationalServiceRegistry,
  defaultPipelineRegistry,
  defaultTaskTypeRegistry,
  describeError,
} from '@cat-factory/kernel'
import { D1WorkspaceRepository } from './infrastructure/repositories/D1WorkspaceRepository'
import { D1WorkspaceSettingsRepository } from './infrastructure/repositories/D1WorkspaceSettingsRepository'
import { D1KeyFingerprintStore } from './infrastructure/repositories/D1KeyFingerprintStore'
import {
  WebCryptoSecretCipher,
  checkKeyFingerprint,
  sweepKeyDriftAndRaise,
} from '@cat-factory/server'

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
// Cross-isolate cache-coherency directory (per-group generation counters; see appCachesHost.ts).
export { CacheGenerationDirectory } from './infrastructure/durable-objects/CacheGenerationDirectory'

// Installation-level AI provisioning extension point: a deployment registers extra
// model-provider registries at startup (e.g. AWS Bedrock from
// @cat-factory/provider-bedrock) and every container build picks them up.
export {
  registerModelRegistry,
  clearModelRegistries,
  type ModelRegistryFactory,
} from './infrastructure/ai/registries'

// Installation-level extension point for the CAPABILITY-CREDENTIAL resolver, registered the same
// way and for the same reason: every container build reads it, so the resolver also serves the
// durable driver, which is where container agents are actually dispatched. Most deployments never
// call this directly, since `createWorker({ createToolSecretResolver })` registers on their
// behalf; it is exported for one assembling its own app, and for tests.
export {
  registerToolSecretPolicy,
  clearToolSecretPolicy,
  type ToolSecretPolicy,
  type ToolSecretResolverFactory,
} from './infrastructure/toolSecretResolver'

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
// Installation-level extension point for predefined pipelines (the same DI seam as agent kinds):
// a deployment news a `defaultPipelineRegistry()`, registers its pipelines on it by reference, and
// injects it via the `pipelineRegistry` override — replacing the old module-global `registerPipeline`.
export { PipelineRegistry, defaultPipelineRegistry } from '@cat-factory/kernel'
// Installation-level extension point for custom task types (the same DI seam as agent kinds):
// a deployment news a `defaultTaskTypeRegistry()`, registers its namespaced task types on it by
// reference, and injects it via the `taskTypeRegistry` override — the SPA renders each as a
// first-class create-task choice + card badge (snapshot `customTaskTypes`).
export { TaskTypeRegistry, defaultTaskTypeRegistry } from '@cat-factory/kernel'
// Installation-level extension point for FOUNDATIONAL SERVICES (the same DI seam again): a
// deployment news a `defaultFoundationalServiceRegistry()`, registers the shared capabilities its
// org already runs on it by reference, and injects it via the `foundationalServiceRegistry`
// override. They resolve as the `builtin` tier of every workspace's catalog, so a board designs
// against the estate from its first request and an account/board can still override or suppress
// any of them. See backend/docs/adr/0031-foundational-services.md.
export {
  FoundationalServiceRegistry,
  type FoundationalServiceDefinition,
  defaultFoundationalServiceRegistry,
} from '@cat-factory/kernel'
// Installation-level extension point for GENERATIVE BINARY INTEGRATIONS (the same DI seam once
// more): a deployment news a `defaultBinaryGeneratorRegistry()`, registers the image / music /
// video generation APIs it pays for on it by reference, and injects it via the
// `binaryGeneratorRegistry` override. A pipeline step whose kind carries the `binary-output`
// trait then SELECTS from them (`stepOptions.binaryOutput.generatorIds`), and the engine briefs
// the agent on each one's content types, contract and credential variable.
export {
  BinaryGeneratorRegistry,
  type BinaryGeneratorDefinition,
  defaultBinaryGeneratorRegistry,
} from '@cat-factory/kernel'
// The app-owned PROMPT-FRAGMENT registry (the same shape once more): a deployment news a
// `promptFragmentRegistryWithBuiltins()` (or a bare `defaultPromptFragmentRegistry()` when it
// wants only its own standards), registers its best-practice fragments and per-task-type default
// sets on it by reference, and injects it via the `promptFragmentRegistry` override. Replaces the
// module-global `registerPromptFragment` seam, which was correct only while every reader resolved
// the same physical copy of `@cat-factory/prompt-fragments`.
// `promptFragmentRegistryWithBuiltins()` is what a deployment wants unless it means the opposite:
// an injected registry REPLACES the pool rather than merging with it, so a bare
// `defaultPromptFragmentRegistry()` is a deployment whose agents fold its own standards and none of
// the platform's. Both are legitimate, which is why both are exported and neither is inferred.
export { PromptFragmentRegistry, defaultPromptFragmentRegistry } from '@cat-factory/kernel'
export { promptFragmentRegistryWithBuiltins } from '@cat-factory/prompt-fragments'
// Installation-level extension point for the deployment's OWN BINARY ARTIFACT STORES: a
// deployment news a `defaultBinaryStoreRegistry()`, registers stores implementing the
// `BinaryBlobBackend` port (GCS, Azure Blob, an internal object service) on it, and passes it via
// the `binaryStoreRegistry` override. Each becomes a `custom` choice in the account-settings storage
// picker, beside the platform's own backends; the per-account resolver builds one when an account
// selects it, and stamps the store's id onto every artifact row it writes.
export {
  BinaryStoreRegistry,
  BinaryStoreRegistrationError,
  type BinaryStoreContext,
  type BinaryStoreDefinition,
  type BinaryStoreView,
  type BinaryBlobBackend,
  defaultBinaryStoreRegistry,
} from '@cat-factory/kernel'
// Installation-level extension point for polling GATES and STEP RESOLVERS. `gateRegistryWithBuiltins()`
// is the one a deployment almost always wants: a bare `defaultGateRegistry()` is EMPTY, so injecting
// one silently drops `ci` / `conflicts` / `post-release-health` from every pipeline that names them.
export {
  GateRegistry,
  defaultGateRegistry,
  type GateDefinition,
  type GateRegistration,
  type GateFactory,
  type GateProbe,
  type GateContext,
  type GateConfigFields,
  StepResolverRegistry,
  defaultStepResolverRegistry,
  type StepCompletionResolver,
  type StepResolverFactory,
  type StepResolution,
  type StepResolverContext,
  type ResolverContext,
} from '@cat-factory/kernel'
export { gateRegistryWithBuiltins } from '@cat-factory/gates'
// Installation-level extension point for JUDGES (the inline-LLM-against-a-rubric bucket of the step
// taxonomy). Empty by default: the platform ships none.
export {
  JudgeRegistry,
  defaultJudgeRegistry,
  type JudgeDefinition,
  type JudgeFactory,
  type JudgeRubric,
  type JudgeSubject,
  type JudgeAssessor,
  type JudgeContext,
} from '@cat-factory/kernel'
// Installation-level extension point for VCS PROVIDERS: the neutral seam a deployment adds a git
// host through, rather than re-hardcoding GitHub in a shared path.
export {
  VcsProviderRegistry,
  defaultVcsRegistry,
  type VcsProviderBundle,
  type VcsProvider,
} from '@cat-factory/kernel'
// The environment + runner backend registries, registered together on ONE bundle because an
// environment backend and its runner backend are two halves of one deployment's infrastructure.
export { createBackendRegistries, type BackendRegistries } from '@cat-factory/integrations'
// The REUSABLE-OPERATION authoring vocabulary: the shapes a deployment's registration literals ARE,
// re-exported so an org package types them against the facade it boots through and needs no direct
// `@cat-factory/kernel` or `@cat-factory/contracts` dependency of its own. That is not a
// convenience: a `workspace:*` dependency publishes as an EXACT version, so a consumer floating the
// range onto a newer patch resolves a SECOND physical copy, and the registration lands in the one
// nothing reads (ADR 0040).
export type {
  CustomTaskType,
  TaskTypePresentation,
  TaskTypeFieldDescriptor,
  TaskTypeFieldType,
  TaskTypeFieldOption,
  DescriptorField,
  DescriptorFieldType,
  DescriptorFieldOption,
  DescriptorFieldShowWhen,
  DescriptorFieldValue,
  DescriptorFieldValues,
  PromptFragment,
  Pipeline,
  PipelineStep,
  AgentKind,
} from '@cat-factory/kernel'
// The boot-validation problem shape, so a deployment can type the `escalateRegistrationWarning`
// predicate it passes to `createWorker()` without a direct `@cat-factory/orchestration` dependency.
export type { RegistrationProblem } from '@cat-factory/orchestration'
// The pure rules over a descriptor's fields, so a deployment's own tests can check a form it
// declares against the same validator the platform's four doors run.
export {
  isDescriptorFieldVisible,
  renderDescriptorFieldValue,
  sanitizeDescriptorFields,
  validateDescriptorFields,
} from '@cat-factory/kernel'
// The BUILT-IN pipeline ids, so an operation can pin one of the shipped pipelines (or a task type
// can name it as its `defaultPipelineId`) without restating a string the platform owns.
export {
  BLUEPRINT_PIPELINE_ID,
  INITIATIVE_PIPELINE_ID,
  INITIATIVE_DOCS_PIPELINE_ID,
  BUILD_PIPELINE_ID,
  SIMPLE_PIPELINE_ID,
  ADAPTIVE_BUILD_PIPELINE_ID,
  TECH_DEBT_PIPELINE_ID,
  BUG_TRIAGE_PIPELINE_ID,
  BUGFIX_PIPELINE_ID,
  CODE_COMMENTS_PIPELINE_ID,
  BUSINESS_DOCS_PIPELINE_ID,
  DOCUMENT_PIPELINE_ID,
  DOCUMENT_QUICK_PIPELINE_ID,
  REVIEW_PIPELINE_ID,
  SPIKE_PIPELINE_ID,
  RALPH_PIPELINE_ID,
} from '@cat-factory/kernel'
// The options {@link createWorker} takes — re-exported from the root so a deployment can name the
// type of what it passes without reaching for the `@cat-factory/worker/app` subpath.
export type { CreateAppOptions } from './app'
// The built-in model-preset ids + the catalog fallback default. A custom Worker entry that builds
// its own app can seed a different out-of-the-box default with
// `createApp({ overrides: { defaultModelPresetId: MODEL_PRESET_SEED_IDS.claude } })` (a
// `Partial<CoreDependencies>` field), parity with the Node/local `start()` seams.
export { DEFAULT_MODEL_PRESET_ID, MODEL_PRESET_SEED_IDS } from '@cat-factory/kernel'

/**
 * The app-owned registries the ENTRY POINT news (as opposed to the per-request set
 * `resolveWorkerRegistries` resolves inside `buildContainer`): each is threaded into `createApp`
 * as an override AND into the boot-time `validateRegistrations`, so the check validates the SAME
 * instance the engine uses, matching the Node/local facades.
 *
 * An injected instance always wins, which is what makes {@link createWorker} a real extension
 * seam: a deployment registers its kinds/gates/pipelines/estate on its own instance and passes it
 * in, exactly as it would through `start({ … })` / `startLocal({ … })` on the other two facades.
 */
function resolveEntryRegistries(overrides: Partial<CoreDependencies>) {
  return {
    // Custom agent kinds (the built-ins plus anything a deployment registered by reference).
    agentKindRegistry: overrides.agentKindRegistry ?? defaultAgentKindRegistry(),
    // Custom initiative presets — the same DI seam as `agentKindRegistry`.
    initiativePresetRegistry:
      overrides.initiativePresetRegistry ?? defaultInitiativePresetRegistry(),
    // The gate registry with the built-in `@cat-factory/gates` suite installed.
    gateRegistry: overrides.gateRegistry ?? gateRegistryWithBuiltins(),
    // Step resolvers (empty by default — the built-in `merger` resolver is a privileged engine
    // built-in, not a registry entry).
    stepResolverRegistry: overrides.stepResolverRegistry ?? defaultStepResolverRegistry(),
    // Judges (empty by default — the platform ships no built-in judges). See
    // `docs/initiatives/judge-registry.md`.
    judgeRegistry: overrides.judgeRegistry ?? defaultJudgeRegistry(),
    // Predefined pipelines (empty by default); registered ones seed into every new workspace and
    // validate at boot.
    pipelineRegistry: overrides.pipelineRegistry ?? defaultPipelineRegistry(),
    // Custom task types (empty by default); registered ones surface in the snapshot.
    taskTypeRegistry: overrides.taskTypeRegistry ?? defaultTaskTypeRegistry(),
    // Foundational services (empty by default — the platform ships no built-in shared
    // capabilities); registered ones are the `builtin` tier of every workspace catalog, and a
    // malformed contract document fails boot rather than a design dispatch.
    foundationalServiceRegistry:
      overrides.foundationalServiceRegistry ?? defaultFoundationalServiceRegistry(),
    // Generative binary integrations (empty by default — the platform ships none). Registered
    // ones are what a binary-generating step may produce with, and a malformed definition or a
    // cleartext endpoint fails boot rather than a dispatch.
    binaryGeneratorRegistry: overrides.binaryGeneratorRegistry ?? defaultBinaryGeneratorRegistry(),
    // The deployment's own binary artifact stores. Resolved here (and again per container build)
    // so ONE instance serves the request path and the cron: the retention sweep builds its stores
    // outside the container entirely.
    binaryStoreRegistry: overrides.binaryStoreRegistry ?? defaultBinaryStoreRegistry(),
    // The best-practice standards pool: the SHIPPED catalog plus whatever a deployment registered
    // onto the same instance. Defaulted to the built-ins by the FACADE (here and, for a container
    // built with no overrides, in `resolveWorkerRegistries`) rather than by `createCore`, because
    // the engine's default is deliberately empty: a facade has to say it wants the platform's
    // standards, through the same public seam a deployment registers on.
    promptFragmentRegistry:
      overrides.promptFragmentRegistry ?? promptFragmentRegistryWithBuiltins(),
  }
}

/** The boot/cron key-fingerprint check's logger, tagged so its lines are greppable by cron. */
const keyFingerprintLogger = logger.child({ cron: 'key-fingerprint' })

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
/**
 * Run kinds already reported as unsweepable in this isolate. The condition is a DEPLOYMENT
 * fault (a workflow binding this build's runs need, not declared in `wrangler.toml`) and it
 * holds for every stale run of that kind on every tick, so warning per run per tick would
 * bury the one line that matters under its own repetitions.
 */
const warnedUnsweepableKinds = new Set<string>()

/** Warn once per isolate that a run kind has no workflow binding, so the sweeper is blind to it. */
function warnUnsweepableKind(kind: string): void {
  if (warnedUnsweepableKinds.has(kind)) return
  warnedUnsweepableKinds.add(kind)
  logger.warn('no workflow binding for run kind; its stale runs cannot be swept', {
    cron: 'stale-run',
    kind,
  })
}
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
/** Queue name of the tracker-webhook consumer, matched against `batch.queue` in `queue()`. */
const TRACKER_SYNC_QUEUE_NAME = 'cat-factory-tracker-sync'

/**
 * Cron schedule (see wrangler.toml `triggers.crons`) that drives the retention
 * sweep. Retention windows are days-to-months long, so a daily pass is plenty —
 * running it on the 2-min run-sweeper cron would just re-issue the same boundary
 * DELETEs ~720×/day against the single D1 writer. Routed by `controller.cron`.
 */
const RETENTION_CRON = '0 3 * * *'

/**
 * How often the frequent `scheduled` tick fires (the every-2-minutes entry in wrangler.toml's
 * `triggers.crons`). A sweep whose
 * cadence is operator-configurable derives its own "is this tick mine" gate from this, since a cron
 * isolate has no memory of the last pass — see `shouldRunReachabilityPass`. Keep in step with the
 * crons list.
 */
const FREQUENT_CRON_PERIOD_MS = 2 * 60_000

/**
 * Daily pass: prune the unbounded ledgers/projections to their retention
 * windows. The tables exist regardless of whether GitHub/agents are
 * configured, so this runs unconditionally; an unused table reclaims nothing.
 */
function runDailyRetentionSweeps(
  env: Env,
  tick: SweepTick,
  clock: SystemClock,
  /**
   * The deployment's own binary artifact stores, from the entry point that owns them. The
   * artifact sweep below RESOLVES each workspace's store to delete its bytes, so without them a
   * deployment's custom-store accounts are swept for nothing: their blobs stay forever and their
   * metadata rows with them. The bare default export passes none, which is correct (it registers
   * none).
   */
  binaryStoreRegistry?: BinaryStoreRegistry,
): void {
  // ADR 0026 D6.1: the Worker has no boot moment, so the O(1) ENCRYPTION_KEY drift check
  // rides the daily cron. It seeds the fingerprint on first run and logs a definitive
  // drift signal on a key change. Independent of (and cheaper than) the retention work.
  if (env.ENCRYPTION_KEY) {
    const encryptionKey = env.ENCRYPTION_KEY
    tick.run(
      { name: 'key-fingerprint', failureMessage: 'key fingerprint check failed' },
      checkKeyFingerprint({
        store: new D1KeyFingerprintStore({ db: env.DB }),
        masterKeyBase64: encryptionKey,
        logger: keyFingerprintLogger,
      }),
    )
    // ADR 0026 D6.2: the drift sweep — decrypt every sealed credential and raise/clear ONE
    // `key_drift` card per affected workspace. Rides the same daily cron as the fingerprint.
    tick.run(
      { name: 'key-drift', failureMessage: 'key drift sweep failed' },
      sweepKeyDriftAndRaise(
        buildContainer(env),
        (info) => new WebCryptoSecretCipher({ masterKeyBase64: encryptionKey, info }),
        keyFingerprintLogger,
      ),
    )
  }
  // This branch never calls buildContainer (no request container is built for the
  // sweep), so do the same fail-fast the build does: a clear error beats an opaque
  // NPE deep in a telemetry repo when the binding is unbound.
  const telemetryDb = requireTelemetryDb(env)
  tick.run(
    { name: 'retention', failureMessage: 'retention sweep failed' },
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
      agentToolCallRepository: new D1AgentToolCallRepository({ db: telemetryDb }),
      // Modeled subscription quota-cycle counters live in the main DB (migration 0047).
      subscriptionQuotaCycleRepository: new D1SubscriptionQuotaCycleRepository({ db: env.DB }),
      pipelineScheduleRepository: new D1PipelineScheduleRepository({ db: env.DB }),
      passwordResetTokenRepository: new D1PasswordResetTokenRepository({ db: env.DB }),
      machineNodeRepository: new D1MachineNodeRepository({ db: env.DB }),
      authAttemptRepository: new D1AuthAttemptRepository({
        db: env.DB,
        idGenerator: new CryptoIdGenerator(),
      }),
      notificationRepository: new D1NotificationRepository({ db: env.DB }),
      // Both operator-observability projections live in the main DB beside `agent_runs`
      // (they are account-scoped through the same `workspaces` sub-select).
      gateOutcomeRepository: new D1GateOutcomeRepository({ db: env.DB }),
      platformMetricsRepository: new D1PlatformMetricsRepository({ db: env.DB }),
      // The account audit log lives in its OWN database (AUDIT_DB), which is why this is the one
      // prune here that does not read `env.DB`: audit retention is measured in years and must not
      // compete with live transactional state for the per-database ceiling.
      auditEventRepository: new D1AuditEventRepository({ db: requireAuditDb(env) }),
      // The durable cost-attribution rollup: this sweep is its only writer, and prunes it
      // nowhere (see `RetentionDeps`).
      spendRollupRepository: new D1SpendRollupRepository({ db: env.DB }),
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
      logger,
    }).then(({ failedTables, ...reclaimed }) => {
      logger.info('retention sweep complete', { cron: 'retention', ...reclaimed })
      // Each failure was already warned at its table; this names the SET, so a table that
      // has been failing every night is one greppable line rather than a pattern to notice.
      if (failedTables.length > 0) {
        logger.warn('retention sweep could not prune every table', {
          cron: 'retention',
          failedTables,
        })
      }
    }),
  )
  // Binary-artifact retention (UI screenshots + reference designs) is per-workspace, and
  // the blob backend is per-account (R2 or S3), so it resolves each workspace's store. Run
  // whenever storage could be configured: the R2 default (ARTIFACT_BUCKET) OR a per-account
  // S3 backend (which needs the encryption key to unseal its credentials).
  if (env.ARTIFACT_BUCKET || env.ENCRYPTION_KEY) {
    const settingsRepo = new D1WorkspaceSettingsRepository({ db: env.DB })
    tick.run(
      { name: 'artifact-retention', failureMessage: 'artifact retention sweep failed' },
      sweepBinaryArtifactRetention({
        resolveStore: buildCloudflareArtifactStoreResolver(
          env,
          env.DB,
          clock,
          new CryptoIdGenerator(),
          binaryStoreRegistry,
        ),
        listWorkspaceIds: () =>
          new D1WorkspaceRepository({ db: env.DB })
            .listVisible(null)
            .then((ws) => ws.map((w) => w.id)),
        retentionDaysFor: (workspaceId) =>
          settingsRepo
            .get(workspaceId)
            .then(
              (s) => s?.artifactRetentionDays ?? DEFAULT_WORKSPACE_SETTINGS.artifactRetentionDays,
            ),
        now: clock.now(),
      }).then((removed) =>
        logger.info('artifact retention sweep complete', {
          cron: 'retention',
          binaryArtifacts: removed,
        }),
      ),
    )
  }
}

/**
 * Re-drive any agent run — execution OR bootstrap — whose Workflows instance
 * died. One sweep over the unified agent_runs table dispatches by kind.
 */
function redriveStuckAgentRuns(env: Env, tick: SweepTick, clock: SystemClock): void {
  if (env.EXECUTION_WORKFLOW || env.BOOTSTRAP_WORKFLOW || env.ENV_CONFIG_REPAIR_WORKFLOW) {
    const sweepLogger = logger.child({ cron: 'stale-run' })
    const execLookup = env.EXECUTION_WORKFLOW
      ? new WorkflowsLookup(env.EXECUTION_WORKFLOW, sweepLogger)
      : null
    const bootLookup = env.BOOTSTRAP_WORKFLOW
      ? new WorkflowsLookup(env.BOOTSTRAP_WORKFLOW, sweepLogger)
      : null
    const repairLookup = env.ENV_CONFIG_REPAIR_WORKFLOW
      ? new WorkflowsLookup(env.ENV_CONFIG_REPAIR_WORKFLOW, sweepLogger)
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
    tick.run(
      { name: 'stale-run', failureMessage: 'run sweep failed' },
      sweepStuckRuns({
        agentRunRepository: new D1AgentRunRepository({ db: env.DB }),
        instanceState: (ref) => {
          const lookup =
            ref.kind === 'bootstrap'
              ? bootLookup
              : ref.kind === 'env-config-repair'
                ? repairLookup
                : execLookup
          // No binding for this kind → nothing can classify this run, now or on any later
          // tick. `alive` said that in a way indistinguishable from a healthy run, so the
          // kind was silently exempt from sweeping forever; `unknown` says it and counts it.
          if (!lookup) {
            warnUnsweepableKind(ref.kind)
            return Promise.resolve({ state: 'unknown' as const })
          }
          return lookup.instanceState(ref.id)
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
        finalizeOrphan: async (ref, cause) => {
          const container = buildContainer(env)
          // The dead instance's own error, when Workflows kept one. Every run this branch
          // settles otherwise carries the identical sentence, which is the least useful thing
          // a stopped run can say about why it stopped.
          const reason = cause
            ? `The run was stopped automatically: its durable driver ended without finalizing it. It reported: ${cause}`
            : 'The run was stopped automatically: its durable driver ended without finalizing it.'
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
        metrics: operationalMetrics,
        logger,
      })
        // Surface what the sweep did — the key signal for "are runs getting stuck?"
        // Only log when it actually acted.
        .then(({ redriven, finalized, stalled, unknown }) => {
          if (redriven > 0 || finalized > 0 || stalled > 0 || unknown > 0) {
            logger.warn('swept stuck runs', {
              cron: 'stale-run',
              redriven,
              finalized,
              stalled,
              // Reported even when nothing else happened: a pass that classified nothing is
              // the one shape of sweep failure that produces no other evidence at all.
              unknown,
            })
          }
        }),
    )
  }
}

/**
 * Env-test self-tests live in their own table (not agent_runs), so the unified run
 * sweep never sees them — this sibling sweep re-drives a run whose Workflows instance
 * was lost and finalizes (cleanup + failed) one whose instance is terminal.
 */
function redriveStuckEnvTests(env: Env, tick: SweepTick, clock: SystemClock): void {
  if (env.ENV_TEST_WORKFLOW) {
    const envTestLookup = new WorkflowsLookup(
      env.ENV_TEST_WORKFLOW,
      logger.child({ cron: 'env-test-sweeper' }),
    )
    const envTestRunner = new WorkflowsEnvironmentTestRunner(env.ENV_TEST_WORKFLOW)
    tick.run(
      { name: 'env-test-sweeper', failureMessage: 'env-test sweep failed' },
      sweepStuckEnvTests({
        repository: new D1EnvironmentTestRunRepository({ db: env.DB }),
        instanceState: (runId) => envTestLookup.instanceState(runId),
        redrive: (workspaceId, runId) => envTestRunner.startRun(workspaceId, runId),
        finalizeOrphan: async (workspaceId, runId, cause) => {
          const container = buildContainer(env)
          const base =
            'The environment test was stopped automatically: its durable driver ended without finalizing it.'
          await container.environments?.environmentTest?.expire(
            workspaceId,
            runId,
            cause ? `${base} It reported: ${cause}` : base,
          )
        },
        clock,
        leaseMs: SWEEP_LEASE_MS,
      }).then(({ redriven, finalized, unknown }) => {
        if (redriven > 0 || finalized > 0 || unknown > 0) {
          logger.warn('swept stuck env-test runs', {
            cron: 'env-test-sweeper',
            redriven,
            finalized,
            unknown,
          })
        }
      }),
    )
  }
}

/**
 * Reclaim expired personal-credential activations (individual-usage subscriptions).
 * Each is a short-lived, system-encrypted per-run copy of a user's token; the TTL
 * bounds standing exposure and a finished run's rows are deleted at completion, but
 * this backstop also clears any that outlived their TTL. The table always exists.
 */
function reclaimExpiredActivations(env: Env, tick: SweepTick, clock: SystemClock): void {
  const activations = new D1SubscriptionActivationRepository({ db: env.DB })
  tick.run(
    { name: 'activation-sweeper', failureMessage: 'activation sweep failed' },
    activations.deleteExpired(clock.now()).then((reclaimed) => {
      if (reclaimed > 0)
        logger.info('reclaimed activations', { cron: 'activation-sweeper', reclaimed })
    }),
  )
}

/**
 * Instance-level container reaper: kill any per-run container that outlived its
 * legitimate maximum lifetime. This is the load-bearing backstop the run-record
 * nets miss — a terminal run whose container survived, or a stuck-`running` run
 * a live driver keeps warm (so its idle sleep clock never starts). Keys off the
 * real live-container inventory, not the run record, and kills via the same
 * EXEC_CONTAINER binding (no Cloudflare API token). With normal runs now self-
 * reclaiming, a reaped container is a genuine leak — the registry logs each loudly.
 */
function reapStaleContainers(env: Env, tick: SweepTick, clock: SystemClock): void {
  if (env.EXEC_CONTAINER) {
    const reaper = new ContainerInstanceRegistry(
      env.EXEC_CONTAINER,
      new D1LiveContainerRepository({ db: env.DB }),
      clock,
    )
    const maxAgeMs = loadConfig(env).execution.containerMaxAgeMs
    tick.run(
      { name: 'container-reaper', failureMessage: 'container reap failed' },
      reaper.reapStaleBefore(clock.now() - maxAgeMs).then(({ reaped }) => {
        if (reaped > 0)
          logger.warn('reaped leaked containers', { cron: 'container-reaper', reaped })
      }),
    )
  }
}

/**
 * The remaining every-2-min backstops: notification escalation, recurring pipelines,
 * the initiative loop, Kaizen gradings, GitHub reconcile, environment teardown, and the
 * platform observability/health sweeps. Each is an independent, no-op-when-unwired sweep.
 */
function runPeriodicBackstops(
  env: Env,
  tick: SweepTick,
  clock: SystemClock,
  scheduledTime: number,
): void {
  // Escalate long-waiting notifications yellow → red (every 2 min). Runs no longer
  // time out waiting for a human, so the escalating notification — past each
  // workspace's `waitingEscalationMinutes` threshold — is the overdue-human signal.
  tick.run(
    { name: 'notification-escalation', failureMessage: 'notification escalation failed' },
    escalateStaleNotifications(buildContainer(env), clock.now()).then((escalated) => {
      if (escalated > 0)
        logger.info('escalated notifications', { cron: 'notification-escalation', escalated })
    }),
  )

  // Fire any due recurring pipelines (every 2 min; the actual cadence is hours).
  // Each due schedule starts its pipeline against its reused block, skipping any
  // whose block already has an active run. No-op when the feature isn't wired.
  tick.run(
    { name: 'recurring-pipelines', failureMessage: 'recurring-pipeline sweep failed' },
    Promise.resolve(buildContainer(env).recurring?.service.runDue(clock.now())).then((result) => {
      if (result && (result.fired > 0 || result.skipped > 0)) {
        logger.info('fired recurring pipelines', { cron: 'recurring-pipelines', ...result })
      }
    }),
  )

  // Tick the initiative execution loop (every 2 min): reconcile each executing initiative's
  // spawned tasks and spawn the next wave up to its concurrency cap. Terminal child runs poke
  // the loop directly, so this is the backstop cadence. No-op when initiatives aren't wired.
  tick.run(
    { name: 'initiative-loop', failureMessage: 'initiative-loop sweep failed' },
    Promise.resolve(buildContainer(env).initiatives?.loop.runDue(clock.now())).then((result) => {
      if (result && (result.spawned > 0 || result.completed > 0)) {
        logger.info('ticked initiative loop', { cron: 'initiative-loop', ...result })
      }
    }),
  )

  // Run any pending Kaizen gradings (every 2 min): the engine only inserts `scheduled`
  // rows at run completion, so this background pass does the actual LLM grading (and
  // re-drives `running` rows orphaned by a crashed sweep). Bounded per pass to stay
  // within the cron budget; no-op when the Kaizen feature isn't wired. The grader's
  // model is resolved per-workspace (Model Configuration), so this is workspace-wide.
  if (!kaizenSweeping) {
    kaizenSweeping = true
    tick.run(
      { name: 'kaizen-sweeper', failureMessage: 'kaizen sweep failed' },
      Promise.resolve(
        buildContainer(env).kaizen?.service.runPending(
          clock.now() - KAIZEN_STALE_MS,
          KAIZEN_SWEEP_BATCH,
        ),
      )
        .then((processed) => {
          if (processed && processed > 0)
            logger.info('ran pending kaizen gradings', { cron: 'kaizen-sweeper', processed })
        })
        // Released on BOTH paths, and it has to stay inside the promise handed to `tick.run`:
        // the in-flight latch is what stops a second tick piling onto a slow grading pass, so a
        // failed pass that never cleared it would wedge Kaizen until the isolate was recycled.
        .finally(() => {
          kaizenSweeping = false
        }),
    )
  }

  // Reconcile GitHub projections that may have missed a webhook (no-op unless
  // the integration is configured).
  tick.run(
    { name: 'github-reconcile', failureMessage: 'github reconcile failed' },
    reconcileStaleRepos(env, clock, GITHUB_RECONCILE_STALE_MS).then((scheduled) => {
      if (scheduled > 0)
        // `sweep:` (not `cron:`) so the summary shares a field with the pass's
        // per-repo lines, which the shared reconcile core emits on both facades.
        logger.info('scheduled repo resyncs', { sweep: 'github-reconcile', scheduled })
    }),
  )

  // Refresh repo-linked FOUNDATIONAL-SERVICE sources whose last sync has aged out, so a merged
  // OpenAPI change reaches the catalog without anyone opening the management surface. Runs on the
  // same hourly cadence as its staleness window through the stateless window gate — a cron isolate
  // has no memory of the last pass, and running the probe every 2 minutes would multiply the reads
  // by 30 for a source that can only go stale once an hour. No-op unless the catalog + GitHub are
  // both wired (nothing is linked to refresh).
  if (
    shouldRunReachabilityPass(scheduledTime, FREQUENT_CRON_PERIOD_MS, FOUNDATIONAL_SOURCE_STALE_MS)
  ) {
    tick.run(
      { name: 'foundational-sources', failureMessage: 'foundational-source sweep failed' },
      sweepFoundationalSources(buildContainer(env).foundationalServices, logger),
    )
  }

  // Tear down ephemeral environments whose TTL has elapsed (no-op unless the
  // environment integration is configured).
  tick.run(
    { name: 'env-sweeper', failureMessage: 'environment sweep failed' },
    sweepExpiredEnvironments(env, clock),
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
    if (sweep)
      tick.run({ name: 'platform-metrics', failureMessage: 'platform metrics sweep failed' }, sweep)
  }

  // Probe each workspace's CONFIGURED infrastructure connections and report a dead one as
  // `unreachable` — raising/clearing an `infra_unreachable` card and pushing an `infraSetup` event
  // on each transition, so the setup banner appears the moment a provider dies rather than on
  // whoever's next reload. Opt-in (`INFRA_REACHABILITY_WATCH`): it is the one sweep that makes an
  // OUTBOUND call per workspace per pass, so the container is built only when opted in — AND, for
  // the same reason, it is the one backstop here that does not run on every tick: it honours
  // `INFRA_REACHABILITY_INTERVAL_MS` through the stateless window gate, so the operator's cadence
  // knob means the same thing on both facades instead of being silently Node-only.
  const reachability = loadConfig(env).infraReachability
  if (
    reachability.enabled &&
    shouldRunReachabilityPass(scheduledTime, FREQUENT_CRON_PERIOD_MS, reachability.intervalMs)
  ) {
    tick.run(
      { name: 'infra-reachability', failureMessage: 'infra reachability sweep failed' },
      sweepInfraReachability(buildContainer(env), logger).then(({ raised, cleared }) => {
        if (raised > 0 || cleared > 0)
          logger.info('infra reachability sweep', { cron: 'infra-reachability', raised, cleared })
      }),
    )
  }

  // Raise/clear `platform_health` notifications when the deployment's OWN run health crosses
  // an operator threshold, per account (the push counterpart to the operator dashboard read).
  // Opt-in (`PLATFORM_ALERTS`); the container (hence the platform-observability read) is built
  // only when opted in so a deployment that hasn't opted in pays nothing.
  if (loadConfig(env).platformAlerts.enabled) {
    tick.run(
      { name: 'platform-health', failureMessage: 'platform health sweep failed' },
      sweepPlatformHealth(buildContainer(env), clock.now(), logger).then(({ raised, cleared }) => {
        if (raised > 0 || cleared > 0)
          logger.info('platform health sweep', { cron: 'platform-health', raised, cleared })
      }),
    )
  }

  // Raise a `budget_threshold` card while a workspace's (or its account's) spend is still
  // recoverable. The proactive half of the spend safeguard, whose only signal today is a run
  // pausing mid-pipeline. Not opt-in: a configured budget is the opt-in. It rides the stateless
  // window gate at the shared cadence, so the Worker and the Node timer sweep equally often.
  if (shouldRunReachabilityPass(scheduledTime, FREQUENT_CRON_PERIOD_MS, SPEND_ALERT_INTERVAL_MS)) {
    tick.run(
      { name: 'spend-alerts', failureMessage: 'spend alert sweep failed' },
      sweepSpendAlerts(buildContainer(env), clock.now(), logger).then(({ raised }) => {
        if (raised > 0) logger.info('spend alert sweep', { cron: 'spend-alerts', raised })
      }),
    )
  }
}

/** The cron sweeper. Module-level (not closed over the app) so {@link createWorker} stays thin. */
async function handleScheduled(
  controller: ScheduledController,
  env: Env,
  ctx: ExecutionContext,
  binaryStoreRegistry?: BinaryStoreRegistry,
): Promise<void> {
  // The ambient ExecutionContext (requestContext.ts): the module-scope cache bag's background
  // work adopts the CURRENT invocation's `waitUntil` through it.
  return runWithExecutionContext(ctx, () => runScheduled(controller, env, ctx, binaryStoreRegistry))
}

async function runScheduled(
  controller: ScheduledController,
  env: Env,
  ctx: ExecutionContext,
  binaryStoreRegistry?: BinaryStoreRegistry,
): Promise<void> {
  applyLogSettings(env)
  const clock = new SystemClock()
  const tick = new SweepTick(ctx)

  // Daily pass: prune the unbounded ledgers/projections to their retention windows.
  if (controller.cron === RETENTION_CRON) {
    runDailyRetentionSweeps(env, tick, clock, binaryStoreRegistry)
  } else {
    // Frequent pass (every 2 min): time-sensitive backstops.
    redriveStuckAgentRuns(env, tick, clock)
    redriveStuckEnvTests(env, tick, clock)
    reclaimExpiredActivations(env, tick, clock)
    reapStaleContainers(env, tick, clock)
    runPeriodicBackstops(env, tick, clock, controller.scheduledTime)
  }
  // This tick's own counters, flushed once its passes have SETTLED. The ordering is the whole
  // point: the collector is per ISOLATE, so a counter a cron pass records can only be exported
  // by a flush that runs after it. Draining while the passes were still in flight meant a cron
  // tick drained an empty collector and left its own counters waiting for a next tick in the
  // same isolate — which for the daily retention cron is a tick that never comes.
  flushTelemetryAfter(tick.settled(), env, ctx, clock)
}

/**
 * Flush THIS ISOLATE's buffered telemetry once `work` settles, as a post-response
 * `waitUntil`: the operational counters, and the exported log lines. Every entry point calls
 * it, because both buffers are per-isolate and an isolate is discarded without warning; see
 * `observability/operationalFlush.ts` for why that makes per-invocation flushing the correct
 * shape rather than a wasteful one.
 *
 * `allSettled` rather than a catch: a FAILED invocation is exactly the one whose counters and
 * lines matter, and its rejection is the caller's to propagate, not this bookkeeping's to
 * observe. Both flushes are best-effort and resolve on failure, so neither can take the other
 * down.
 */
function flushTelemetryAfter(
  work: Promise<unknown>,
  env: Env,
  ctx: ExecutionContext,
  clock: SystemClock,
): void {
  ctx.waitUntil(
    Promise.allSettled([work]).then(() => {
      // ONE `loadOtelConfig` for both flushes, rather than the narrow read beside a whole
      // `loadConfig(env).otel` (which is literally this same call). Both are telemetry that a
      // deployment whose config validation fails still owes its operator, so neither should
      // depend on the full config parsing cleanly.
      const otel = loadOtelConfig(env)
      return Promise.all([
        flushOperationalMetricsForIsolate(otel, clock.now()) ?? undefined,
        flushOtelLogsForIsolate(otel) ?? undefined,
      ]).then(() => {})
    }),
  )
}

/** The queue consumer multiplexing the three queues. Module-level, like {@link handleScheduled}. */
async function handleQueue(
  batch: MessageBatch<ExecutionStartMessage | GitHubSyncMessage | TrackerSyncMessage>,
  env: Env,
  ctx: ExecutionContext,
): Promise<void> {
  // Same ambient-ExecutionContext bracket as `handleScheduled` (requestContext.ts).
  return runWithExecutionContext(ctx, async () => {
    applyLogSettings(env)
    const work = routeQueueBatch(batch, env)
    flushTelemetryAfter(work, env, ctx, new SystemClock())
    await work
  })
}

/** The routing half of {@link handleQueue}, split out so the flush can bracket the whole batch. */
async function routeQueueBatch(
  batch: MessageBatch<ExecutionStartMessage | GitHubSyncMessage | TrackerSyncMessage>,
  env: Env,
): Promise<void> {
  // Route by source queue — the single handler serves all three queues.
  if (batch.queue === GITHUB_SYNC_QUEUE_NAME) {
    await handleGitHubSyncBatch(batch as MessageBatch<GitHubSyncMessage>, env)
    return
  }

  // Inbound tracker deliveries (push-driven intake + ticket replies to a parked review).
  if (batch.queue === TRACKER_SYNC_QUEUE_NAME) {
    await handleTrackerSyncBatch(batch as MessageBatch<TrackerSyncMessage>, env)
    return
  }

  // Execution admission queue: create the Workflows instance per message.
  if (!env.EXECUTION_WORKFLOW) {
    logger.warn('execution admission: no EXECUTION_WORKFLOW binding; acking without starting', {
      queue: batch.queue,
      messages: batch.messages.length,
    })
    for (const message of batch.messages) message.ack()
    return
  }
  const runner = new WorkflowsWorkRunner({ workflow: env.EXECUTION_WORKFLOW })
  for (const message of batch.messages as MessageBatch<ExecutionStartMessage>['messages']) {
    try {
      await runner.create(message.body.workspaceId, message.body.executionId)
      message.ack()
    } catch (error) {
      // Retrying blind used to be the WHOLE handling: a run that can never start burned its
      // retries and then vanished, with no evidence it was ever admitted. The tracker-sync
      // sibling has always logged; this matches it.
      logger.warn('execution admission failed; retrying message', {
        queue: batch.queue,
        workspaceId: message.body.workspaceId,
        executionId: message.body.executionId,
        attempts: message.attempts,
        ...describeError(error),
      })
      message.retry()
    }
  }
}

/** The Worker's exported handler shape (fetch + the cron and queue consumers). */
export type WorkerHandler = ExportedHandler<
  Env,
  ExecutionStartMessage | GitHubSyncMessage | TrackerSyncMessage
>

/**
 * Build the Worker's exported handler — the Cloudflare facade's INSTALLATION SEAM, and the
 * counterpart of the Node facade's `start({ … })` / the local facade's `startLocal({ … })`.
 *
 * A deployment that only re-exports {@link default} cannot register anything: the registries
 * would be newed here, in a module it does not own, and never handed back. So a deployment that
 * ships custom agent kinds, gates, pipelines, task types or a foundational-service estate writes
 * ONE line instead of reassembling this boot sequence itself:
 *
 * ```ts
 * export default createWorker({ overrides: { foundationalServiceRegistry } })
 * ```
 *
 * Everything the bare default export owns is owned here — the `LOG_LEVEL` read (which mutates
 * module state inside `@cat-factory/server`, so it must run in the copy the Worker actually logs
 * through), the once-guarded registration validation over whatever registries the options carry,
 * and the `scheduled` / `queue` handlers. Re-exporting `default` and spreading it to keep the
 * non-`fetch` handlers is therefore never necessary, and a handler added here later reaches such
 * a deployment without it having to notice.
 */
export function createWorker(options: CreateAppOptions = {}): WorkerHandler {
  const registries = resolveEntryRegistries(options.overrides ?? {})
  const app = createApp({ ...options, overrides: { ...options.overrides, ...registries } })
  return {
    // Validate the registered extensions (gates / agent kinds) ONCE, on the first request —
    // by which point every `register*` import side effect has run. A typo'd gate helperKind or
    // an unknown resultView then fails loudly at boot instead of mid-run. The once-guard keeps
    // it off the hot path (the Worker rebuilds its container per request, but this never re-runs).
    fetch(request: Request, env: Env, ctx: ExecutionContext) {
      // The Worker has no process env, so the configured verbosity is read off the request's
      // `env` binding. Cheap and idempotent, so it runs on every entry point rather than being
      // guarded — a `scheduled`/`queue` invocation can be the FIRST to run in a fresh isolate.
      applyLogSettings(env)
      reportDeploymentDocumentProblemsOnce(env)
      validateRegistrationsOnce({
        // The resolved bundle whole, for the reason the two Node-hosted facades pass their
        // container: a hand-picked list is the one shape that can silently be short by one.
        //
        // The deployment's document resolver joins it HERE rather than at `createWorker`, because
        // it is the one member derived from `env`, which a Worker only has once a request arrives.
        // Omitting it read as "this deployment configured no document credentials", so every
        // `builtin`-tier fragment naming a living document failed validation on a deployment that
        // had configured them correctly, and since the once-guard flips only after a clean pass,
        // it failed on every request rather than once.
        registries: { ...registries, ...deploymentDocumentDeps(env) },
        onWarn: (problem) => logger.warn(problem.message, { code: problem.code }),
        // Deployment policy over platform judgement, the same seam the Node/local entry points
        // expose: a warning the platform must keep soft (it structurally cannot see whether an
        // unresolved fragment id is a typo or a tenant-tier row) may be a hard defect for THIS
        // deployment. Here the refusal surfaces as a failing request rather than a failed boot,
        // because a Worker has no boot moment; the once-guard flips only after a clean pass, so it
        // stays loud until fixed.
        escalateWarning: options.escalateRegistrationWarning,
      })
      // The ambient-ExecutionContext bracket (requestContext.ts): background work the
      // module-scope cache bag starts while serving this request adopts THIS request's
      // `waitUntil` through it, resolved at spawn time.
      const response = Promise.resolve(
        runWithExecutionContext(ctx, () => app.fetch(request, env, ctx)),
      )
      // Flush whatever THIS isolate counted while serving the request, after the response.
      flushTelemetryAfter(response, env, ctx, new SystemClock())
      return response
    },
    // The registries this entry point resolved ride into the cron, because one of its sweeps
    // (binary-artifact retention) builds a per-account store OUTSIDE the container and therefore
    // outside every other route a registration takes.
    scheduled: (controller, env, ctx) =>
      handleScheduled(controller, env, ctx, registries.binaryStoreRegistry),
    queue: handleQueue,
  }
}

/**
 * Report every deployment document source whose credentials are set but unusable, once per isolate.
 *
 * A Worker has no boot moment, so the report the two Node facades make while starting has to be
 * staged against the first request here: the same shape, and for the same reason, as the
 * once-guarded registration check it sits beside. Left ungated it would repeat on every request,
 * which is how an operator learns to filter out the one line naming the variable they mistyped.
 *
 * Per-ISOLATE rather than per-deployment, like every other module-scope value in this file
 * (`defaultWorker`): an isolate is the only lifetime a Worker has to hang one on, and a report
 * repeated once per cold start is the honest cost of that.
 */
let deploymentDocumentProblemsReported = false
function reportDeploymentDocumentProblemsOnce(env: Env): void {
  if (deploymentDocumentProblemsReported) return
  deploymentDocumentProblemsReported = true
  for (const { source, problem } of deploymentDocumentProblems(env)) {
    logger.warn(
      'Deployment-wide document-source credentials are set but unusable, so this source cannot ' +
        'back a code-registered prompt fragment',
      { source, problem },
    )
  }
}

/**
 * The default worker, built on FIRST USE rather than at module evaluation.
 *
 * Laziness is load-bearing now that {@link createWorker} is the seam: `import { createWorker }`
 * evaluates this module, so an eager `createWorker()` here would build a second complete app
 * inside every deployment that only wanted the factory — paid for at module scope, which on
 * Workers is the startup-CPU budget rather than a request's. A deployment exporting its own
 * `createWorker({ … })` never calls this, so it never builds it.
 */
let defaultWorker: WorkerHandler | null = null
function theDefaultWorker(): WorkerHandler {
  defaultWorker ??= createWorker()
  return defaultWorker
}

/**
 * The default deployment shape: every registry defaulted. Unchanged for a bare re-export.
 *
 * `scheduled`/`queue` are the module-level handlers directly — they never touch the app, so
 * making them go through the lazy build would construct one for a cron tick that has no use
 * for it.
 */
export default {
  // Parameters taken FROM the handler type rather than restated, so the forwarder cannot drift
  // from the signature workerd actually calls.
  fetch: (...args: Parameters<NonNullable<WorkerHandler['fetch']>>) =>
    theDefaultWorker().fetch!(...args),
  scheduled: handleScheduled,
  queue: handleQueue,
} satisfies WorkerHandler
