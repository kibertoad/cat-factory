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
  UnavailableError,
  UnauthorizedError,
  RateLimitedError,
  RunContendedError,
  ReviewContendedError,
  assertFound,
  getErrorMessage,
  getErrorReason,
  type DomainErrorCode,
  type CredentialRequiredReason,
  type ConflictReason,
} from './domain/errors.js'
export { sameSubtasks, sameSubtaskItems, parseSubtasks } from './domain/subtasks.logic.js'
export {
  type CachePolicy,
  providerCachePolicy,
  providerCachesPrompts,
} from './domain/cache-policy.js'
export { resolveWritebackFlag } from './domain/writeback.js'
export {
  AUDIT_PAGE_LIMIT_DEFAULT,
  AUDIT_PAGE_LIMIT_MAX,
  auditActorColumns,
  auditEventColumns,
  auditPageLimit,
  decodeAuditCursor,
  decodeAuditDetails,
  encodeAuditCursor,
  encodeAuditDetails,
  rowToAuditActor,
  rowToAuditEventView,
  type AuditCursor,
  type AuditEventColumns,
  type AuditEventRow,
} from './domain/audit-log.js'
// `narrowMergeClassRule` is NOT re-exported from here: it moved to `@cat-factory/contracts` beside
// the rule maps it composes, so the preset editor in the SPA narrows by the same implementation the
// engine applies. A convenience re-export would put two import paths on one rule, which is the
// shape that lets a second hand-written copy exist. `resolveMergeClassRule` /
// `resolveRoleScopedMergeClassRule` followed it there when the SPA's risk-policy picker had to
// agree about what a role's entry costs that role, and are not re-exported for the same reason.
// What stays here is the CLASSIFICATION of a diff, which nothing in the SPA decides.
export {
  CHANGE_CLASS_RANK,
  classifyChangedPath,
  classifyChangedFiles,
  type ChangeClassification,
} from './domain/change-class.js'
export { extractJson } from './domain/llm-output.js'
export {
  detectValidationChecks,
  RepoView,
  type DetectedCheck,
  type ValidationDetectionResult,
  type EcosystemDetection,
  type EcosystemDetector,
  type RepoRootEntry,
  type RepoSurface,
  type ValidationCheckRole,
} from './domain/validation-detection.js'
export {
  DEFAULT_VALIDATION_DETECTORS,
  LANGUAGE_DETECTORS,
  TASK_RUNNER_DETECTORS,
  VALIDATION_DETECTION_CONTENT_FILES,
} from './domain/validation-detectors.js'
export { UNATTRIBUTED_CALL_PHASE, normalizeCallPhase } from './domain/llm-phase.js'
export type {
  LlmKindRollup,
  LlmPhaseRollup,
  LlmRateResolver,
  LlmTokenClassCounts,
  LlmTokenRates,
} from './domain/llm-rollup.js'
export {
  costOfTokenClasses,
  foldRollupTotals,
  foldRollupsByAgentKind,
  foldRollupsByPhase,
  priceRollupCells,
  rollupInputTokens,
} from './domain/llm-rollup.js'
export type {
  ToolCallKindRollup,
  ToolCallRollupTotals,
  ToolCallToolRollup,
} from './domain/tool-call-rollup.js'
export {
  foldToolCallTotals,
  foldToolCallsByAgentKind,
  foldToolCallsByTool,
  toolCallFailureRate,
  worstToolRetryLoop,
} from './domain/tool-call-rollup.js'
export { bugHuntScore, parseBugHuntVerdicts, rankBugCandidates } from './domain/bug-hunt-logic.js'
export {
  BLOCK_TYPE_LABEL,
  DEFAULT_RISK_POLICY,
  DEFAULT_MERGE_CLASS_RULES,
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
  presetOverrideForKind,
  type ModelPresetSeed,
} from './domain/catalog.js'
export {
  type SelectableModel,
  type ModelVariant,
  type BedrockVariant,
  type SubscriptionVariant,
  type SubscriptionVendorConfig,
  type ProviderCapabilities,
  type ModelCostResolver,
  MODEL_CATALOG,
  MODEL_FLAVORS,
  DEFAULT_PROVIDER_PREFERENCE,
  orderedProviderPreference,
  resolveBedrockModelId,
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
export type { RetiredPipeline } from './domain/seed.js'
export {
  seedBlocks,
  seedPipelines,
  retiredPipelines,
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
export {
  applicableFragmentIds,
  describeOwnService,
  resolveServiceFrameBlock,
} from './domain/block-tree.js'
export type { OwnServiceContext } from './domain/block-tree.js'
// Installation-level extension point for predefined pipelines (mirrors the custom
// agent-kind / gate registry seams): a deployment registers extra pipelines on the app-owned
// `PipelineRegistry` at startup and `seedPipelines(registry)` seeds them into every new workspace.
export { PipelineRegistry, defaultPipelineRegistry } from './domain/pipeline-registry.js'

// Installation-level extension point for CUSTOM task types (mirrors the agent-kind / pipeline
// registry seams): a deployment registers namespaced task types on the app-owned
// `TaskTypeRegistry` at startup; the server projects them into the snapshot (`customTaskTypes`)
// and `defaultPipelineIdForTaskType` consults it after the built-in map.
export { TaskTypeRegistry, defaultTaskTypeRegistry } from './domain/task-type-registry.js'
// The run-time half of that seam: a custom type's collected form values joined with its
// descriptor's labels, once per dispatch, for every prompt-assembling path to render.
export { describeCustomTaskType } from './domain/task-type-context.js'
export type { CustomTaskFieldContext, CustomTaskTypeContext } from './domain/task-type-context.js'
// The pure rules over a descriptor's fields, re-exported (not restated) from contracts so an org
// package registering an operation imports its WHOLE vocabulary from kernel and needs no contracts
// dependency, exactly as it does for `CustomTaskType` itself.
export {
  isDescriptorFieldVisible,
  renderDescriptorFieldValue,
  sanitizeDescriptorFields,
  validateDescriptorFields,
} from '@cat-factory/contracts'

// Installation-level extension point for initiative PRESETS (mirrors the pipeline / gate
// registry seams): a preset bundles a create-time form descriptor + planning-pipeline binding
// + defaults + code hooks (repo-detection prefill, plan post-processor, prompt steering). The
// built-in `preset_generic` is the strangler default. See `domain/initiative-preset-registry.ts`.
export {
  type InitiativePresetRegistration,
  GENERIC_INITIATIVE_PRESET_ID,
  InitiativePresetRegistry,
} from './domain/initiative-preset-registry.js'

// The foundational-services catalog: pure recognition/indexing/rendering of the shared
// capability catalog an Architect designs against and its consumers lazily read.
// See `domain/foundational-services.ts` and backend/docs/adr/0031-foundational-services.md.
export {
  type FoundationalCatalogRead,
  type FoundationalCatalogView,
  type FoundationalContractBundle,
  type FoundationalDefinitionProblem,
  type FoundationalIndexRead,
  FOUNDATIONAL_CATALOG_FILE,
  FOUNDATIONAL_CONTEXT_DIR,
  FOUNDATIONAL_DECLARATION_TAG,
  FOUNDATIONAL_INDEX_FILE,
  MAX_CATALOG_OPERATIONS,
  MAX_CONTRACT_BODY_CHARS,
  contextFileFor,
  describeFoundationalProblem,
  detectContractFormat,
  indexContractOperations,
  indexOpenApiOperations,
  indexToadContractOperations,
  isContractCandidatePath,
  isContractModulePath,
  isOpenApiDocument,
  parseFoundationalDeclaration,
  renderContractDocument,
  renderFoundationalCatalog,
  renderFoundationalIndex,
  summarizeContract,
  validateFoundationalDefinition,
} from './domain/foundational-services.js'

// The app-owned registry a DEPLOYMENT registers its own foundational services on — the
// `builtin` tier of the catalog merge, mirroring the pipeline / task-type registries.
export {
  type FoundationalServiceDefinition,
  type FoundationalServiceRegistryEntry,
  FoundationalServiceRegistry,
  defaultFoundationalServiceRegistry,
} from './domain/foundational-service-registry.js'

// Where that `builtin` tier is READ from: the in-process registry by default, the MOTHERSHIP's
// over `/internal/foundational-services` on a mothership-mode node (which has no estate of its
// own to be authoritative about). See `ports/foundational-builtins.ts`.
export {
  type FoundationalBuiltinSource,
  registryBuiltinSource,
} from './ports/foundational-builtins.js'

// The app-owned registry a DEPLOYMENT registers its best-practice PROMPT FRAGMENTS (and the
// per-task-type default sets that select them) on. Replaces the two module globals in
// `@cat-factory/prompt-fragments`, which were correct only while every reader resolved the same
// physical copy of that package. The shipped catalog installs onto one through the same public
// seam (`promptFragmentRegistryWithBuiltins()`).
export {
  PromptFragmentRegistry,
  defaultPromptFragmentRegistry,
} from './domain/prompt-fragment-registry.js'

// Where that pool is READ from: the in-process registry by default, the MOTHERSHIP's over
// `/internal/prompt-fragments` on a mothership-mode node. See `ports/prompt-fragments.ts`.
export {
  type PromptFragmentSource,
  registryPromptFragmentSource,
} from './ports/prompt-fragments.js'

// Binary-output steps: pure validation/parsing/rendering for a kind that generates binary
// artifacts and stores them through a selected foundational service, scoped by further
// selected context services. See `domain/binary-outputs.ts` and
// docs/initiatives/binary-output-foundational-storage.md.
// The `.cat-context/` PATH vocabulary is exported from the leaf that owns it, not through either
// half: the two halves import each other, so a value read across that cycle at module-init time
// is a boot crash the typecheck cannot see (see `domain/binary-output-paths.ts`).
export {
  BINARY_GENERATOR_CONTEXT_DIR,
  BINARY_OUTPUT_BRIEF_FILE,
  BINARY_OUTPUT_CONTEXT_DIR,
  binaryContextFileFor,
  binaryGeneratorContextFileFor,
} from './domain/binary-output-paths.js'
export {
  type BinaryOutputBriefInput,
  type BinaryOutputConfigIssue,
  BINARY_OUTPUT_DECLARATION_TAG,
  ASSET_STORAGE_CAPABILITY,
  GENERATION_CONTEXT_CAPABILITY,
  MAX_BINARY_OUTPUT_ENTRIES,
  binaryOutputConfigIssues,
  describeBinaryOutputConfigIssues,
  parseBinaryOutputDeclaration,
  renderBinaryOutputBrief,
} from './domain/binary-outputs.js'

// The GENERATIVE half of a binary-output step: the app-owned registry a DEPLOYMENT registers its
// image / music / video generation integrations on, and the pure logic that resolves a step's
// selection against it, refuses one that cannot deliver the step's content types, and renders
// what the agent is told about each. See `domain/binary-generators.ts`.
export {
  type BinaryGeneratorDefinition,
  type BinaryGeneratorView,
  BinaryGeneratorRegistry,
  defaultBinaryGeneratorRegistry,
} from './domain/binary-generator-registry.js'

// Where those integrations are READ from: the in-process registry by default, the MOTHERSHIP's
// over `/internal/binary-generators` on a mothership-mode node (whose own build can only hold a
// second, drifting copy of what the builder's picker offered). See
// `ports/binary-generators.ts`.
export {
  type BinaryGeneratorSource,
  memoizeBinaryGeneratorViews,
  registryBinaryGeneratorSource,
} from './ports/binary-generators.js'
// `binaryFormatCoverage` is NOT re-exported from here: it moved to `@cat-factory/contracts`
// beside the vocabulary it reads, so the SPA imports the same implementation the backend does.
// A convenience re-export would put two import paths on one rule, which is the shape that let a
// second hand-written copy exist in the first place.
export {
  type BinaryGeneratorSelectionIssue,
  type ResolvedBinaryGenerator,
  type ResolvedBinaryGeneratorSelection,
  binaryGeneratorSelectionIssues,
  describeBinaryGeneratorSelectionIssues,
  dispatchBinaryGenerators,
  resolveBinaryGeneratorSelection,
} from './domain/binary-generators.js'

// The shared reader for an agent's machine-read ` ```<tag> ` declaration block — the LAST one
// wins, because every contract using it asks the agent to END its reply with it.
export { extractFencedDeclaration } from './domain/fenced-declaration.js'

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
  type GateRegistration,
  type GateConfigFields,
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

// Installation-level extension point for JUDGES — the fourth step-taxonomy bucket (an LLM
// assessment against a rubric, compared to a per-task threshold, disposed as
// advance/park/bounce/fail). A deployment registers its own judge on the app-owned registry
// the composition root injects. See `domain/judge-registry.ts` + `domain/judge-logic.ts` and
// `docs/initiatives/judge-registry.md`.
export {
  type JudgeRubric,
  type JudgeSubject,
  type JudgeAssessor,
  type JudgeDefinition,
  type JudgeContext,
  type JudgeFactory,
  JudgeRegistry,
  defaultJudgeRegistry,
  stubJudgeContext,
} from './domain/judge-registry.js'
export {
  type JudgeDispositionInput,
  type JudgeDispositionResult,
  JUDGE_SEVERITY_RANK,
  disposeJudgeVerdict,
  renderJudgeRework,
} from './domain/judge-logic.js'

// Typed provider registry: the deployment-supplied data sources a gate (or other
// extension) probes, keyed by an opaque {@link ProviderToken}. Replaces the per-provider
// module-global wire/get boilerplate. See `domain/provider-registry.ts`.
export {
  type ProviderToken,
  ProviderRegistry,
  defineProviderToken,
  defaultProviderRegistry,
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
  VcsProviderRegistry,
  defaultVcsRegistry,
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

// The job-body capability handshake: which optional body fields the running image parses, and
// the three-state answer a dispatch draws from that. See `domain/harness-capabilities.ts`.
export {
  HARNESS_BODY_CAPABILITIES,
  type BlindJobStopOutcome,
  type HarnessBodyCapability,
  type HarnessCapabilitySupport,
  describeHarnessBodyCapability,
  harnessCapabilityUnsupportedMessage,
  isHarnessBodyCapability,
  parseHarnessBodyCapabilities,
  readRunnerDispatchAck,
  requiredHarnessCapabilities,
  resolveHarnessCapabilitySupport,
} from './domain/harness-capabilities.js'

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

// Per-step human-gate approval: who may resolve a gate and when a quorum is met. The rule lives in
// `@cat-factory/contracts` because the SPA must agree about the answer (it disables the approve
// button and renders the tally), and is re-exported here so the engine reaches it alongside the
// rest of its vocabulary.
export {
  type GateActor,
  type GateApprovalRefusal,
  UNATTRIBUTED_GATE_ACTOR,
  foldGateApproval,
  hasApproverPolicy,
  refuseGateResolution,
  requiredGateApprovals,
} from '@cat-factory/contracts'

// W3C Trace Context: the shared reading of an inbound `traceparent`, so the HTTP boundary that
// ADOPTS a caller's trace and the OTLP exporter that STAMPS it onto a line agree about the
// field names and the validity rules. See `domain/trace-context.ts`.
export type { InboundTraceContext } from './domain/trace-context.js'
export {
  SPAN_ID_FIELD,
  TRACEPARENT_HEADER,
  TRACE_ID_FIELD,
  parseTraceparent,
} from './domain/trace-context.js'

// Infrastructure REACHABILITY: the pure decision the watcher sweep and the board snapshot share
// — what to record, which transitions to announce, and how a recorded outage folds into the
// setup projection. See `domain/infra-reachability.ts`.
export type {
  InfraSetupTransition,
  ProbeOutcome,
  ProbeVerdict,
  ReachabilityDecision,
  SavedConnectionProbe,
} from './domain/infra-reachability.js'
export {
  applyInfraReachability,
  decideReachability,
  recordedUnreachableAreas,
} from './domain/infra-reachability.js'

// Where an ordered `-f` compose layer's text comes from (the primary repo, a directly-supplied
// document, or another repo), and the pure placement rules both consumers share — the compose
// environment provider and the shared-stack bring-up. See `domain/compose-sources.ts`.
export {
  normalizeComposeFileRef,
  normalizeComposeFileRefs,
  composePathDir,
  composeProjectDir,
  composeBaseDepth,
  materializedComposePath,
  composeSourcesNeedPrimaryRepo,
  describeComposeSource,
} from './domain/compose-sources.js'

// The "a referenced context document reaches the agent whole, or the run breaks loudly naming it"
// invariant, shared by the engine's resolution path and the container's materialiser. See
// `domain/context-references.ts`.
export {
  CONTEXT_DOCUMENT_UNREADABLE,
  CONTEXT_DOCUMENTS_OVER_BUDGET,
  type ContextReferenceRef,
  hasReadableContent,
  contextExcerptFor,
  originSuffix,
  originHeaderLine,
  assertContextDocumentsReadable,
  assertContextReferencesFit,
} from './domain/context-references.js'

// Tiered consensus selection: which of a step's candidate model groups a task's estimate earns.
export {
  clearsConsensusBar,
  consensusGroupBar,
  selectConsensusGroup,
  applyConsensusGroup,
} from './domain/consensus-groups.js'

// The marker-delimited splice that makes the engine's PR verification report idempotent.
export {
  PR_REPORT_MARKER_START,
  PR_REPORT_MARKER_END,
  spliceManagedSection,
  readManagedSection,
} from './domain/pr-report.js'

// The PRE-DISPATCH INPUT GATE's pure check: is there anything in a task's authored input an agent
// could act on? Runs before a run's first dispatch, so an unactionable task parks having spent
// no tokens. See `domain/input-gate.ts`.
export {
  INPUT_GATE_SEVERITY,
  type InputGateInput,
  type InputGateVerdict,
  evaluateInputGate,
  inputGateInputOf,
  hasBlockingInputIssues,
  describeInputGateIssues,
} from './domain/input-gate.js'

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

// Agent capabilities — the skills an agent kind applies and the tool servers (MCP) it may call.
// See `backend/docs/custom-agents.md` → "Capabilities: skills and tools".
export {
  type McpHttpTransport,
  type McpOAuthConfig,
  type McpSecretRef,
  type McpServerDefinition,
  type McpStdioTransport,
  type McpTransport,
  type ResolvedSkill,
  type ResolvedSkillResource,
  type ResolvedToolServer,
  type SkillVersionPin,
  type UnavailableToolServer,
  MCP_HARNESS_TRANSPORTS,
  MCP_OAUTH_DEFAULT_HEADER,
  MCP_OAUTH_DEFAULT_HEADER_TEMPLATE,
  MCP_SERVER_ID_PATTERN,
  MCP_SUPPORTED_HARNESSES,
  MCP_TOOL_NAME_PATTERN,
  TOOL_SERVER_BUDGET,
  isAllowedMcpHttpUrl,
  isLoopbackMcpHttpUrl,
  isValidMcpServerId,
  isValidMcpToolName,
  mcpHarnessServesTransport,
  mcpServableHarnesses,
  mcpServerSupportsHarness,
  toolServerDeclaredBytes,
} from './domain/agent-capabilities.js'

export {
  type ServiceRegistrationDeps,
  registerServiceForFrame,
} from './domain/service-registration.js'

export { applyMountLayout } from './domain/mount-layout.js'
export { normalizeWorkspaceMetadata } from './domain/workspace-metadata.js'

export { MapSourceRegistry } from './shared/source-registry.logic.js'
export * as atlassianLogic from './shared/atlassian.logic.js'
export {
  markdownToText,
  buildExcerpt,
  estimateTokens,
  contentHash,
} from './shared/markdown.logic.js'
export {
  FRAGMENT_BRIEF_MAX_BODY_RATIO,
  FRAGMENT_BRIEF_MAX_CHARS,
  FRAGMENT_BRIEF_MIN_BODY_CHARS,
  bodyWarrantsBrief,
  fragmentBodyFingerprint,
  isNotCondensableMarker,
  isUsableBrief,
  resolveFragmentBrief,
} from './domain/fragment-brief.js'
export type { FragmentBriefResolution, StoredFragmentBrief } from './domain/fragment-brief.js'
/**
 * The boundary every host-bound body (a PR description, a tracker-issue comment) renders
 * untrusted text through. Exported as a NAMESPACE because its members are deliberately
 * generic verbs (`inline`/`cell`/`prose`) whose safety guarantee is only obvious with the
 * qualifier at the call site — `hostMarkdown.prose(finding.detail)` reads as the boundary
 * crossing it is, where a bare `prose(...)` reads like formatting.
 */
export * as hostMarkdown from './shared/host-markdown.logic.js'
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
export { describeProcessExit } from './shared/process-exit.logic.js'
export { describeError, runBestEffort } from './shared/best-effort.js'
export {
  createStoreAgentContextGate,
  type StoreAgentContextGate,
} from './shared/agent-context-gate.js'
export {
  createInitiatorPatGate,
  type InitiatorPatGate,
  type InitiatorPatAccountTier,
} from './shared/initiator-pat-gate.js'
export {
  type RepoScanEntry,
  type CheckoutFreeRepoReader,
  joinRepoPath,
  BudgetedRepoScanner,
} from './shared/repo-scan.logic.js'
export {
  type ManifestMatchConfidence,
  type ManifestSignature,
  type ManifestSignatureMatch,
  type CustomProviderConfigSeed,
  type CustomManifestDetectionContext,
  type CustomManifestDetection,
  allPresent,
  anyPresent,
  firstPresent,
  readTextFile,
  readYamlDoc,
  readYamlDocs,
  listFiles,
  matchManifestSignature,
} from './shared/manifest-probe.logic.js'

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
