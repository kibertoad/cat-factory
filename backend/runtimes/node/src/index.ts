// @cat-factory/node-server — the Node.js runtime facade. Serves the shared
// @cat-factory/server Hono app via @hono/node-server, wiring Node implementations of
// the runtime ports over a Drizzle/Postgres persistence layer (the single store used
// in dev, test and prod). `start()` boots an HTTP server; `createServer()` returns the
// app (for embedding/tests); `buildNodeContainer()` is the composition root.
export {
  backfillDeclaredSeeds,
  createApp,
  createServer,
  serveAppWithRealtime,
  serveMisconfigured,
  start,
  type CreateServerOptions,
  // The boot entry point's options as a named type: a deployment types its own wrapper against it,
  // and the local facade's seam guard derives what IT must expose from it rather than keeping a
  // second copy of the list.
  type StartOptions,
} from './server.js'
// Process-level failure guards (unhandled rejection / uncaught exception), shared with the
// local facade so both Node-hosted deployments crash-report the same way.
export { installProcessFailureGuards } from './processGuards.js'
// The opt-in OTLP log export, re-exported for the local facade's MOTHERSHIP boot: it never
// calls `start()`, so without this it would be the one Node-hosted deployment shape whose logs
// stop at stdout while every other one exports them.
export { startOtelLogExport, type LogExportHandle } from './logExport.js'
// The shared periodic-sweep helper (run-once-first, non-overlapping, unref'd, best-effort),
// re-exported so the local facade's mothership boot — which never calls `start()`, and so gets
// none of the sweepers wired there — prunes its local telemetry store on the same shape.
export { startSweeper, type SweeperOptions } from './sweeper.js'
// Real-time WebSocket transport pieces, re-exported so the local facade's mothership boot
// (which does NOT call `start()`, since there is no Postgres/pg-boss) can stand up the same
// per-workspace hub + `ws` upgrade listener the standard Node boot does.
export {
  NodeRealtimeHub,
  NodeEventPublisher,
  attachRealtime,
  type LocalEventSink,
  type MachineSubscribeDeps,
  type RealtimeRoomListener,
  type RealtimeRoomWatcher,
} from './realtime.js'
// The layered cross-node real-time propagator (Redis today; more adapters later). A multi-node
// Node deployment sets REDIS_URL and every browser sees every event regardless of which node
// produced it; single-node / local mode wires none of this.
export {
  LayeredEventPropagator,
  buildRealtimePropagator,
  type RealtimeMessage,
  type WebSocketPropagator,
} from './propagator.js'
export {
  RedisWebSocketPropagator,
  DEFAULT_REALTIME_CHANNEL,
  type RedisWebSocketPropagatorOptions,
} from './redisPropagator.js'
// Mothership-side real-time upstream delivery: injects a relayed engine event from a
// mothership-mode node into this deployment's own fan-out (the symmetric Node side of the
// per-workspace Durable Object relay on Cloudflare).
export { LocalMachineEventRelay } from './machineEventRelay.js'
export {
  warnIfRedisUnreachable,
  probeRedisReachable,
  describeRedisUnreachable,
  redisTargetLabel,
  DEFAULT_REDIS_PROBE_TIMEOUT_MS,
  type RedisProbeResult,
  type RedisConnectProbe,
} from './redisProbe.js'
export {
  buildNodeContainer,
  buildNodeResolveTransport,
  withProvisioningLog,
  type NodeContainerOptions,
} from './container.js'
export { loadNodeConfig } from './config.js'
// Boot-phase timing (app-startup initiative, item 1), re-exported so local mode times its own
// preflights (runtime probe, PAT probe) with the same helper `bootServer` uses.
export { startBootClock, type BootClock } from './bootTimings.js'
// Re-exported so the local facade can pass a `cachesProfile` override to `start()` (it makes
// the repo projection pass-through — its `link-repo` CLI writes the projection out-of-process
// with no invalidation bus). It imports only from `@cat-factory/node-server`.
export { DEFAULT_APP_CACHES_PROFILE, type AppCachesProfile } from '@cat-factory/caching'
export { createNodeGateways } from './gateways.js'
// The BASE resolver plus the env-built trace-sink instrument. A caller assembling its own
// container composes them with `wrapResolverWithInstrumentation` — in that order, never the
// reverse; see the wrap's own doc for what instrumenting innermost hides.
export { createNodeModelProviderResolver, inlineInstrumentFromEnv } from './modelProvider.js'

// Installation-level extension point (mirroring the Worker facade): a deployment news a
// `defaultAgentKindRegistry()`, registers its own kinds on it by reference, and injects it
// through `buildNodeContainer`/`start()`'s `agentKindRegistry` option — the app-owned DI seam
// that replaces the old module-global `registerAgentKind` side effect. Bedrock-style model
// providers mix in via createNodeModelProvider.
export {
  AgentKindRegistry,
  defaultAgentKindRegistry,
  type AgentKindDefinition,
} from '@cat-factory/agents'
// Installation-level extension point for custom initiative presets (the same DI seam as agent
// kinds): a deployment news a `defaultInitiativePresetRegistry()`, registers its own presets on it
// by reference, and injects it through `buildNodeContainer`/`start()`'s `initiativePresetRegistry`
// option — replacing the old module-global `registerInitiativePreset` side effect.
export { defaultInitiativePresetRegistry } from '@cat-factory/agents'
export { InitiativePresetRegistry, type InitiativePresetRegistration } from '@cat-factory/kernel'
// Installation-level extension point for predefined pipelines (the same DI seam as agent kinds):
// a deployment news a `defaultPipelineRegistry()`, registers its pipelines on it, and passes it to
// `start()` via `buildContainer`'s `pipelineRegistry` option — replacing the old `registerPipeline`.
export { PipelineRegistry, defaultPipelineRegistry } from '@cat-factory/kernel'
// Installation-level extension point for custom task types (the same DI seam as agent kinds):
// a deployment news a `defaultTaskTypeRegistry()`, registers its namespaced task types on it, and
// passes it to `start()` via `buildContainer`'s `taskTypeRegistry` option — the SPA renders each
// as a first-class create-task choice + card badge (snapshot `customTaskTypes`).
export { TaskTypeRegistry, defaultTaskTypeRegistry } from '@cat-factory/kernel'
// Installation-level extension point for FOUNDATIONAL SERVICES (the same DI seam again): a
// deployment news a `defaultFoundationalServiceRegistry()`, registers the shared capabilities its
// org already runs on it, and passes it via the `foundationalServiceRegistry` option. They resolve
// as the `builtin` tier of every workspace's catalog, so a board designs against the estate from
// its first request. See backend/docs/adr/0031-foundational-services.md.
export {
  FoundationalServiceRegistry,
  type FoundationalServiceDefinition,
  defaultFoundationalServiceRegistry,
} from '@cat-factory/kernel'
// Installation-level extension point for GENERATIVE BINARY INTEGRATIONS (the same DI seam once
// more): a deployment news a `defaultBinaryGeneratorRegistry()`, registers the image / music /
// video generation APIs it pays for on it, and passes it via the `binaryGeneratorRegistry`
// option. A pipeline step whose kind carries the `binary-output` trait then SELECTS from them
// (`stepOptions.binaryOutput.generatorIds`), and the engine briefs the agent on each one's
// content types, contract and credential variable.
export {
  BinaryGeneratorRegistry,
  type BinaryGeneratorDefinition,
  defaultBinaryGeneratorRegistry,
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
// The app-owned PROMPT-FRAGMENT registry: the best-practice standards pool an operation's
// `defaultFragmentIds` resolve against.
//
// `promptFragmentRegistryWithBuiltins()` is what a deployment wants unless it means the opposite:
// an injected registry REPLACES the pool rather than merging with it, so a bare
// `defaultPromptFragmentRegistry()` is a deployment whose agents fold its own standards and none of
// the platform's. Both are legitimate, which is why both are exported and neither is inferred.
export { PromptFragmentRegistry, defaultPromptFragmentRegistry } from '@cat-factory/kernel'
export { promptFragmentRegistryWithBuiltins } from '@cat-factory/prompt-fragments'
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
// predicate it passes to `start()` without a direct `@cat-factory/orchestration` dependency.
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
} from '@cat-factory/kernel'
// The built-in model-preset ids + the catalog fallback default, re-exported so a deploy-app
// wrapper can name a preset when passing `start({ defaultModelPresetId })` without a direct
// `@cat-factory/kernel` import.
export { DEFAULT_MODEL_PRESET_ID, MODEL_PRESET_SEED_IDS } from '@cat-factory/kernel'
// The shapes a deployment declares its INFRA DEPENDENCIES with, re-exported so a deploy-app
// wrapper can type its `seedSharedStacks` (and hand-write an inline compose layer) without a
// direct `@cat-factory/kernel` / `@cat-factory/contracts` import.
export type { ComposeFileRef, ComposeSource, CreateSharedStackInput } from '@cat-factory/kernel'
export { SystemClock, CryptoIdGenerator } from './runtime.js'
// Re-exported so the local facade can build its own provisioning-log recorder for the
// per-workspace transport chooser without taking a direct @cat-factory/integrations dep.
export { ProvisioningLogRecorder } from '@cat-factory/integrations'
export { createDbClient, type DbClient, type DrizzleDb } from './db/client.js'
export { migrate } from './db/migrate.js'
// Execution driver pieces, re-exported so the local facade's mothership boot (no pg-boss)
// can run the SAME advance/poll loop in-process with real timer-backed sleeps.
export { executionRuntime, type ExecutionRuntime } from './execution/config.js'
export { driveExecution, type DriveConfig, type DriveOutcome } from './execution/drive.js'
export {
  createDrizzleRepositories,
  type CoreRepositories,
  DrizzleAccountSettingsRepository,
  DrizzleLocalSettingsRepository,
  DrizzleWorkspaceSettingsRepository,
  DrizzleWorkspaceRepository,
  DrizzleWorkspaceMemberRepository,
} from './repositories/drizzle.js'
export {
  DrizzleGitHubInstallationRepository,
  DrizzleRunnerPoolConnectionRepository,
} from './repositories/containerExecution.js'
// The Drizzle GitHub projection repositories, re-exported so a test harness (the e2e backend)
// can wire the GitHub module purely through `buildNodeContainer`'s `overrides` seam — no real
// GitHub App required (the read endpoints serve from these projections; see the e2e testServer).
export {
  DrizzleRepoProjectionRepository,
  DrizzleBranchProjectionRepository,
  DrizzlePullRequestProjectionRepository,
  DrizzleIssueProjectionRepository,
  DrizzleCommitProjectionRepository,
  DrizzleCheckRunProjectionRepository,
} from './repositories/github.js'
export { DrizzleNotificationRepository } from './repositories/notifications.js'
export { DrizzleDocumentRepository } from './repositories/documents.js'
export { DrizzleTaskRepository } from './repositories/tasks.js'
export { DrizzleDocInterviewRepository } from './repositories/drizzle.js'
export { DrizzleEnvironmentUserHandlerRepository } from './repositories/environmentUserHandler.js'
export * as schema from './db/schema.js'
export {
  FilesystemBinaryBlobBackend,
  DEFAULT_FILE_STORAGE_PATH,
} from './storage/FilesystemBinaryBlobBackend.js'
export { PostgresBinaryBlobBackend } from './storage/PostgresBinaryBlobBackend.js'
