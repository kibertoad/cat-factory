// @cat-factory/local-server — the local-mode runtime facade. It is the Node.js
// facade (@cat-factory/node-server: shared Hono app + Drizzle/Postgres + pg-boss)
// with two differentiators so a developer can run the whole product on their own
// machine: agent jobs run as per-run local containers (Docker/Podman/OrbStack/Colima/
// Apple `container`, selected by LOCAL_CONTAINER_RUNTIME), and GitHub is
// reached via a personal access token (no GitHub App). `startLocal()` boots the
// service; `buildLocalContainer()` is the composition root.
export { startLocal } from './server.js'
export { buildLocalContainer } from './container.js'
export { loadLocalConfig, applyLocalDefaults } from './config.js'
export {
  LocalContainerRunnerTransport,
  createLocalContainerTransportFromEnv,
  type LocalContainerRunnerTransportOptions,
} from './LocalContainerRunnerTransport.js'
export {
  type ContainerRuntimeAdapter,
  type ContainerExec,
  type RuntimeId,
  createRuntimeAdapter,
  resolveRuntimeId,
  runtimeProfile,
  resolveHostAlias,
  DockerRuntimeAdapter,
  AppleContainerRuntimeAdapter,
} from './runtimes/index.js'
// Seed the github_installations/github_repos projection so container agent steps can
// resolve a target repo in local mode (no GitHub App connect flow). Also a CLI:
// `node dist/link-repo.js <workspaceId> <frameBlockId> <owner/repo>`.
export { linkRepo, type LinkRepoOptions, type LinkedRepo } from './linkRepo.js'
// PAT-backed GitHub access for the CI gate + merge / mergeability providers.
export { createLocalGitHubClient, LocalPatAppTokenSource } from './github.js'

// Mothership mode: the local `node:sqlite` credential store (the agent/model secrets that
// stay on the laptop, sealed with the local key, while org/durable state lives on the
// mothership). See docs/initiatives/mothership-mode.md. Only the factory + its type are
// public; the raw db opener and the repo classes stay internal until the 1b composition
// step proves a consumer needs them.
export { createLocalCredentialStore, type LocalCredentialStore } from './sqlite/credentialStore.js'
// Mothership composition: the remote (RPC) + local-sqlite repository set, the durable
// SQLite-backed work runner that replaces pg-boss, and the boot-mode probe. `startLocal()` selects
// the no-Postgres boot automatically when LOCAL_MOTHERSHIP_URL is set.
export {
  composeMothership,
  isMothershipMode,
  SqliteWorkRunner,
  type SqliteWorkRunnerOptions,
  type MothershipComposition,
} from './mothership.js'

// Installation-level extension point, re-exported for parity with the Node facade: a local
// deployment news a `defaultAgentKindRegistry()`, registers its own kinds on it by reference,
// and injects it via `buildLocalContainer`/`startLocal()`'s `agentKindRegistry` option (the
// app-owned DI seam that replaces the old module-global `registerAgentKind` side effect).
export {
  AgentKindRegistry,
  defaultAgentKindRegistry,
  type AgentKindDefinition,
} from '@cat-factory/agents'
// Installation-level extension point for custom initiative presets (parity with the Node facade
// + the agent-kind seam): a local deployment news a `defaultInitiativePresetRegistry()`, registers
// its own presets on it by reference, and injects it via `startLocal()`'s `initiativePresetRegistry`
// option — replacing the old module-global `registerInitiativePreset` side effect.
export { defaultInitiativePresetRegistry } from '@cat-factory/agents'
export { InitiativePresetRegistry, type InitiativePresetRegistration } from '@cat-factory/kernel'
// Installation-level extension point for predefined pipelines (the same DI seam as agent kinds):
// a deployment news a `defaultPipelineRegistry()`, registers its pipelines on it, and passes it to
// `startLocal()` via the `pipelineRegistry` container option — replacing the old `registerPipeline`.
export { PipelineRegistry, defaultPipelineRegistry } from '@cat-factory/kernel'
// Installation-level extension point for custom task types (the same DI seam as agent kinds):
// a deployment news a `defaultTaskTypeRegistry()`, registers its namespaced task types on it, and
// passes it to `startLocal()` via the `taskTypeRegistry` option — the SPA renders each as a
// first-class create-task choice + card badge (snapshot `customTaskTypes`).
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
// content types, contract and credential variable. In MOTHERSHIP mode register them on the
// MOTHERSHIP's entry point rather than here: a run resolves the set from there (it is what the
// builder's picker offered), and this node's copy would only ever be the stale one.
export {
  BinaryGeneratorRegistry,
  type BinaryGeneratorDefinition,
  defaultBinaryGeneratorRegistry,
} from '@cat-factory/kernel'
// Installation-level extension point for polling GATES and STEP RESOLVERS (parity with the Node
// facade). `gateRegistryWithBuiltins()` is the one a deployment almost always wants: a bare
// `defaultGateRegistry()` is EMPTY, so injecting one silently drops `ci` / `conflicts` /
// `post-release-health` from every pipeline that names them.
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
// Through the Node facade rather than `@cat-factory/gates` directly: local IS the Node stack with
// two differentiators, and it already depends on it, so a second physical path to the same builder
// would be one more package a consumer could float out of step.
export { gateRegistryWithBuiltins } from '@cat-factory/node-server'
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
// predicate it passes to `startLocal()` without a direct `@cat-factory/orchestration` dependency.
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
// The built-in model-preset ids + the catalog fallback default, re-exported so a local deploy-app
// wrapper can name a preset when passing `startLocal({ defaultModelPresetId })` without a direct
// `@cat-factory/kernel` import (parity with the Node facade).
export { DEFAULT_MODEL_PRESET_ID, MODEL_PRESET_SEED_IDS } from '@cat-factory/kernel'
// The shapes a deployment declares its INFRA DEPENDENCIES with, re-exported so a deploy-app
// wrapper can type its `seedSharedStacks` (and hand-write an inline compose layer) without a
// direct `@cat-factory/kernel` / `@cat-factory/contracts` import.
export type { ComposeFileRef, ComposeSource, CreateSharedStackInput } from '@cat-factory/kernel'
