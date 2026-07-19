// Shared vocabulary, pure logic, and port interfaces for the domain packages
// (@cat-factory/orchestration, @cat-factory/integrations, …).

export * from './domain/types.js'
export {
  DomainError,
  NotFoundError,
  ValidationError,
  ConflictError,
  CredentialRequiredError,
  ForbiddenError,
  RunContendedError,
  assertFound,
  getErrorMessage,
  getErrorReason,
  type DomainErrorCode,
  type CredentialRequiredReason,
  type ConflictReason,
} from './domain/errors.js'
export { sameSubtasks, sameSubtaskItems } from './domain/subtasks.logic.js'
export {
  type CachePolicy,
  providerCachePolicy,
  providerCachesPrompts,
} from './domain/cache-policy.js'
export { resolveWritebackFlag } from './domain/writeback.js'
export { extractJson } from './domain/llm-output.js'
export {
  BLOCK_TYPE_LABEL,
  DEFAULT_RISK_POLICY,
  RISK_POLICY_SEEDS,
  seedRiskPolicies,
  type RiskPolicySeed,
  DEFAULT_CI_MAX_ATTEMPTS,
  DEFAULT_MAX_REQUIREMENT_ITERATIONS,
  CONTEXT_BUDGET,
  DEFAULT_WORKSPACE_SETTINGS,
  DEFAULT_MODEL_PRESETS,
  DEFAULT_MODEL_PRESET,
  DEFAULT_MODEL_PRESET_ID,
  MODEL_PRESET_SEED_IDS,
  seedModelPresets,
  modelForKindFromPreset,
  type ModelPresetSeed,
} from './domain/catalog.js'
export {
  type SelectableModel,
  type ModelVariant,
  type SubscriptionVariant,
  type SubscriptionVendorConfig,
  type ProviderCapabilities,
  type ModelCostResolver,
  MODEL_CATALOG,
  SUBSCRIPTION_VENDORS,
  ALL_SUBSCRIPTION_VENDORS,
  getSelectableModel,
  contextWindowFor,
  effectiveCatalog,
  effectiveCatalogWith,
  type LocalEndpointModels,
  localSelectableModels,
  parseLocalModelId,
  openRouterSelectableModels,
  parseOpenRouterModelId,
  resolveModelRef,
  isModelUsable,
  isModelUsableInline,
  nativeVendorForRef,
  subscriptionVendorForRef,
  subscriptionOptionFor,
  isIndividualVendor,
  isAmbientNativeVendor,
  INDIVIDUAL_VENDORS,
  individualVendorForModelId,
  personalCredentialVendorForModelId,
  familyForModelId,
  isAllowedByFamilyPolicy,
} from './domain/models.js'
export {
  SUBSCRIPTION_QUOTA_WINDOWS,
  SUBSCRIPTION_QUOTA_CEILINGS,
  subscriptionQuotaWindowMs,
  subscriptionQuotaCeiling,
  isSubscriptionVendor,
} from './domain/subscription-quota.js'
export {
  seedBlocks,
  seedPipelines,
  BLUEPRINT_PIPELINE_ID,
  INITIATIVE_PIPELINE_ID,
  INITIATIVE_DOCS_PIPELINE_ID,
  DEP_UPDATE_PIPELINE_ID,
  TECH_DEBT_PIPELINE_ID,
  BUG_TRIAGE_PIPELINE_ID,
  CODE_COMMENTS_PIPELINE_ID,
  BUSINESS_DOCS_PIPELINE_ID,
  DOCUMENT_PIPELINE_ID,
  DOCUMENT_QUICK_PIPELINE_ID,
  defaultPipelineIdForTaskType,
} from './domain/seed.js'

// Pure initiative vocabulary (agent-kind constants + pipeline-shape predicates),
// shared by the agents package and the execution engine's runnable guard.
export {
  INITIATIVE_INTERVIEWER_AGENT_KIND,
  INITIATIVE_ANALYST_AGENT_KIND,
  INITIATIVE_PLANNER_AGENT_KIND,
  INITIATIVE_COMMITTER_AGENT_KIND,
  INITIATIVE_AGENT_KINDS,
  isInitiativeAgentKind,
  hasInitiativeKinds,
} from './domain/initiative-logic.js'
// The interactive document-review interviewer agent-kind constant (WS5).
export { DOC_INTERVIEWER_AGENT_KIND } from './domain/doc-interview-logic.js'
// Pure block-tree walks (the single home for service-frame resolution shared by the engine
// context builder and the test-secrets store).
export { resolveServiceFrameBlock } from './domain/block-tree.js'
// Installation-level extension point for predefined pipelines (mirrors the custom
// agent-kind / model-provider registry seams): a deployment registers extra pipelines at
// startup and `seedPipelines()` seeds them into every new workspace.
export {
  registerPipeline,
  registerPipelines,
  registeredPipelines,
  clearRegisteredPipelines,
} from './domain/pipeline-registry.js'

// Installation-level extension point for initiative PRESETS (mirrors the pipeline / gate
// registry seams): a preset bundles a create-time form descriptor + planning-pipeline binding
// + defaults + code hooks (repo-detection prefill, plan post-processor, prompt steering). The
// built-in `preset_generic` is the strangler default. See `domain/initiative-preset-registry.ts`.
export {
  type InitiativePresetRegistration,
  GENERIC_INITIATIVE_PRESET_ID,
  InitiativePresetRegistry,
} from './domain/initiative-preset-registry.js'

// Installation-level extension point for custom polling gates + step-completion
// resolvers (mirrors the agent-kind / pipeline registry seams): a deployment registers
// its own gate / resolver at startup and the ExecutionService merges them with the
// built-ins. See `domain/gate-registry.ts` / `domain/step-resolver-registry.ts`.
export {
  type GateProbe,
  type GateHelperOutcome,
  type GateHelperJobResult,
  type GateHelperCompletionArgs,
  type GateExhaustedArgs,
  type GateDefinition,
  type GateContext,
  type GateFactory,
  recordGateAttempt,
  GateRegistry,
  defaultGateRegistry,
  stubGateContext,
} from './domain/gate-registry.js'
export {
  type StepResolverContext,
  type StepResolution,
  type StepCompletionResolver,
  type ResolverContext,
  type StepResolverFactory,
  StepResolverRegistry,
  defaultStepResolverRegistry,
  stubResolverContext,
} from './domain/step-resolver-registry.js'

// Typed provider registry: the deployment-supplied data sources a gate (or other
// extension) probes, keyed by an opaque {@link ProviderToken}. Replaces the per-provider
// module-global wire/get boilerplate. See `domain/provider-registry.ts`.
export {
  type ProviderToken,
  defineProviderToken,
  wireProvider,
  getProvider,
  isProviderWired,
  requireProvider,
  clearProviders,
} from './domain/provider-registry.js'

// Provider-neutral VCS identity vocabulary + the per-provider adapter registry. The
// neutral successor to GitHub's `installationId`-keyed surface, selecting a concrete
// adapter (`github` / `gitlab`) via the {@link VcsProvider} discriminator on the
// connection. See `domain/vcs-types.ts` / `domain/vcs-registry.ts`.
export {
  type VcsProvider,
  type VcsConnectionRef,
  type VcsRepoRef,
  VCS_PROVIDERS,
  isVcsProvider,
  githubConnectionRef,
  githubInstallationId,
} from './domain/vcs-types.js'
export {
  type VcsProviderBundle,
  registerVcsProvider,
  getVcsProvider,
  isVcsProviderRegistered,
  requireVcsProvider,
  resolveVcsProvider,
  registeredVcsProviders,
  clearVcsProviders,
} from './domain/vcs-registry.js'
export {
  type VcsHttpErrorContext,
  describeVcsApiError,
  VCS_DOC_URLS,
  GITHUB_SETTINGS_URLS,
} from './domain/vcs-errors.js'
export {
  DispatchError,
  DISPATCH_DOC_URLS,
  harnessDispatchError,
  harnessDispatchFailureMessage,
  isDispatchFailure,
} from './domain/dispatch-errors.js'

// The structured harness failure-cause vocabulary + the single shared cause → coarse-kind
// mapper every job-failure classifier prefers over its error-string regex. See
// `domain/harness-failure.ts`.
export {
  HARNESS_FAILURE_CAUSES,
  type HarnessFailureCause,
  isHarnessFailureCause,
  failureKindFromHarnessCause,
} from './domain/harness-failure.js'

// Pure gate logic + gate/helper agent-kind constants, shared by the built-in gate suite
// (`@cat-factory/gates`) and the engine. See `domain/gate-logic.ts`.
export {
  CI_AGENT_KIND,
  CI_FIXER_AGENT_KIND,
  CONFLICTS_AGENT_KIND,
  CONFLICT_RESOLVER_AGENT_KIND,
  POST_RELEASE_HEALTH_AGENT_KIND,
  ON_CALL_AGENT_KIND,
  HUMAN_REVIEW_AGENT_KIND,
  FIXER_AGENT_KIND,
  DOC_QUALITY_AGENT_KIND,
  DOC_FIXER_AGENT_KIND,
  type CiVerdict,
  type ReleaseGateVerdict,
  aggregateCi,
  aggregateRepoCi,
  headFields,
  isCiGreen,
  listFailingChecks,
  listFailingChecksAcrossRepos,
  describeFailingChecks,
  describeFailingRepos,
  classifyReleaseHealth,
  describeRegressedSignals,
  renderReleaseEvidence,
} from './domain/gate-logic.js'

// Pure structural analysis of a drafted Markdown document — the `doc-quality` gate's check.
export {
  type DocStructureInput,
  type DocStructureAnalysis,
  type Heading,
  analyzeDocStructure,
  documentHeadings,
  hasDocStructureIssues,
  resolveDocLinkPath,
} from './domain/doc-quality-logic.js'

export * from './ports/index.js'

export {
  type ServiceRegistrationDeps,
  registerServiceForFrame,
} from './domain/service-registration.js'

export { MapSourceRegistry } from './shared/source-registry.logic.js'
export * as atlassianLogic from './shared/atlassian.logic.js'
export {
  markdownToText,
  buildExcerpt,
  estimateTokens,
  contentHash,
} from './shared/markdown.logic.js'
export { normalizeAtlassianBaseUrl, assertSafeAtlassianBaseUrl } from './shared/atlassian.logic.js'
export { normalizeUrl, urlMatchCandidates } from './shared/url.logic.js'
export {
  isPrivateV4,
  decimalV4,
  mappedV4,
  decodeIpv4,
  isCloudMetadataHost,
  isBlockedPrivateHost,
} from './shared/ip-host.logic.js'
export {
  isSecretShapedFilename,
  redactSecrets,
  redactSecretsDeep,
} from './shared/redact-secrets.logic.js'
export {
  type RepoScanEntry,
  type CheckoutFreeRepoReader,
  joinRepoPath,
  BudgetedRepoScanner,
} from './shared/repo-scan.logic.js'

export { requireWorkspace } from './workspace-guard.js'

export {
  WORKSPACE_SCOPED_TABLES,
  WORKSPACE_CASCADE_SPECIAL_TABLES,
  type WorkspaceScopedTable,
} from './domain/workspace-cascade.js'

export {
  WORKSPACE_ROLE_PERMISSIONS,
  workspaceRoleAtLeast,
  permissionsForRole,
  resolveWorkspaceAccess,
  type WorkspaceAccess,
  type WorkspaceAccessRow,
  type ResolveWorkspaceAccessInput,
} from './domain/workspace-access.js'

export { type TaskContextView, renderTaskContext } from './shared/tasks-prompt.logic.js'
