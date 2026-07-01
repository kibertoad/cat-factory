export { AiAgentExecutor, type AiAgentExecutorDependencies } from './agents/runtime/executor.js'
export {
  type InlineWebSearchOptions,
  DEFAULT_INLINE_WEB_SEARCH_KINDS,
  DEFAULT_INLINE_WEB_SEARCH_MAX_USES,
  webResearchGuidanceFor,
  inlineWebSearchOptionsFromEnv,
  providerWebSearchTools,
} from './agents/runtime/web-search.js'
export {
  type AgentModelConfig,
  type AgentRouting,
  type StepModelResolvers,
  type StepModelInputs,
  resolveAgentConfig,
  resolveStepModelRef,
  resolveInlineModelRef,
} from './agents/runtime/routing.js'
export { systemPromptFor, userPromptFor } from './agents/catalog.js'
export { TASK_ESTIMATOR_AGENT_KIND } from './agents/prompts/roles.js'
// Installation-level extension point for custom agent kinds (mirrors the model-provider
// registry seam): a deployment registers extra kinds at startup and the prompt catalog +
// the Worker's executor routing pick them up.
export {
  type AgentKindDefinition,
  registerAgentKind,
  registerAgentKinds,
  registeredAgentKind,
  registeredAgentKinds,
  registeredKindRequiresContainer,
  registeredConfigContributions,
  registeredAgentStep,
  registeredPreOps,
  registeredPostOps,
  registeredAgentPresentation,
  registeredStructuredOutput,
  clearRegisteredAgentKinds,
} from './agents/kinds/registry.js'
export {
  isInlineModelStep,
  REQUIREMENTS_REVIEW_AGENT_KIND,
  CLARITY_REVIEW_AGENT_KIND,
  REQUIREMENTS_BRAINSTORM_AGENT_KIND,
  ARCHITECTURE_BRAINSTORM_AGENT_KIND,
} from './agents/kinds/step-surface.js'
// Schema-driven structured output: derive a kind's `agent.output` spec + a typed parser from
// one valibot schema instead of a hand-written shapeHint string + lenient coercer.
export {
  type StructuredOutput,
  type StructuredOutputOptions,
  defineStructuredOutput,
} from './agents/kinds/structured-output.js'
// Agent capability traits (standard + custom). `code-aware` gates the engine's folding
// of the service's best-practice fragments; `spec-aware` appends the in-repo-spec guidance.
export {
  type AgentTrait,
  type AgentTraitDefinition,
  CODE_AWARE_TRAIT,
  SPEC_AWARE_TRAIT,
  BINARY_STORAGE_TRAIT,
  SPEC_AWARE_GUIDANCE,
  STANDARD_AGENT_TRAITS,
  registerAgentTrait,
  registerAgentTraits,
  registeredAgentTrait,
  clearRegisteredAgentTraits,
  assignAgentTraits,
  clearAssignedAgentTraits,
  traitsFor,
  hasTrait,
  traitGuidanceFor,
} from './agents/kinds/traits.js'
// Per-agent-kind execution tuning (today: progress-guard knobs) folded into a container
// dispatch's job body. Loosen-only, so a kind's normal pattern isn't killed mid-progress.
export { type AgentTuning, type AgentGuardTuning, agentTuningFor } from './agents/kinds/tuning.js'
// Agent configuration-contribution catalog (the descriptors surfaced on task
// creation / inspector, frozen once the contributing step runs).
export {
  PLAYWRIGHT_E2E_TARGET_CONFIG_ID,
  configContributionsFor,
  configContributionCatalog,
} from './agents/kinds/configs.js'
// Tester / Fixer track prompts + helpers.
export {
  isTestingKind,
  testingSystemPrompt,
  testerEnvironmentSection,
} from './agents/prompts/testing.js'
// Requirements-review prompt text + its versioned-prompt registry.
export {
  REVIEW_SYSTEM_PROMPT,
  REWORK_SYSTEM_PROMPT,
  WRITER_SYSTEM_PROMPT,
} from './agents/prompts/requirements.js'
// Clarity-review (bug-report triage) prompt text.
export {
  CLARITY_REVIEW_SYSTEM_PROMPT,
  CLARITY_REWORK_SYSTEM_PROMPT,
} from './agents/prompts/clarity.js'
// Brainstorm (structured-dialogue) prompt text.
export {
  REQUIREMENTS_BRAINSTORM_SYSTEM_PROMPT,
  ARCHITECTURE_BRAINSTORM_SYSTEM_PROMPT,
  REQUIREMENTS_BRAINSTORM_REWORK_SYSTEM_PROMPT,
  ARCHITECTURE_BRAINSTORM_REWORK_SYSTEM_PROMPT,
} from './agents/prompts/brainstorm.js'
export {
  type VersionedPrompt,
  type PromptId,
  PROMPT_VERSIONS,
  promptVersion,
  promptVersionLabel,
  promptVersionForKind,
} from './agents/kinds/versions.js'
export { KAIZEN_SYSTEM_PROMPT } from './agents/prompts/kaizen.js'
export {
  composeSystemPrompt,
  composeBlockSystemPrompt,
  type ComposableBlock,
} from './agents/runtime/fragments.js'
export {
  type StandardPhase,
  STANDARD_PHASES,
  STANDARD_PHASE_BY_KIND,
  phaseForKind,
  standardSystemPrompt,
  renderStandardUserPrompt,
  CONTEXT_DIR,
} from './agents/prompts/standard.js'
export {
  type AcceptanceAgentKind,
  ACCEPTANCE_AGENT_KINDS,
  acceptanceSystemPrompt,
  isAcceptanceKind,
  testApproachSection,
} from './agents/prompts/acceptance.js'
export {
  type CompanionDefinition,
  COMPANIONS,
  isCompanionKind,
  companionFor,
  companionTargets,
  isContainerBackedCompanion,
} from './agents/kinds/companions.js'
export { companionSystemPrompt } from './agents/prompts/companion.js'
// The document-authoring agent kinds (doc-researcher / doc-outliner / doc-writer /
// doc-finalizer), registered as a SIDE EFFECT of importing this module so they are
// first-class kinds in every deployment (Worker / Node / local). `doc-reviewer` — the
// writer's companion — lives in the COMPANIONS catalog above.
export {
  DOC_RESEARCHER_KIND,
  DOC_OUTLINER_KIND,
  DOC_WRITER_KIND,
  DOC_FINALIZER_KIND,
  DOC_REVIEWER_KIND,
  DOCUMENT_AGENT_KINDS,
  registerDocumentAgents,
} from './agents/kinds/document.js'
export {
  READ_ONLY_AGENT_KINDS,
  READ_ONLY_GUARDRAIL,
  isReadOnlyAgentKind,
} from './agents/kinds/read-only.js'
export { MOCK_AGENT_KIND, isMockKind, mockSystemPrompt } from './agents/prompts/mock.js'
export {
  type BusinessLogicAgentKind,
  BUSINESS_LOGIC_AGENT_KINDS,
  BUSINESS_DOCUMENTER_KIND,
  BUSINESS_REVIEWER_KIND,
  BUSINESS_LOGIC_DOCS_DIR,
  isBusinessLogicKind,
  businessLogicSystemPrompt,
} from './agents/prompts/business-logic.js'
export { PLATFORM_DELIVERY_CONTRACT } from './agents/prompts/delivery-contract.js'
export {
  FINAL_ANSWER_IN_REPLY,
  FOLLOW_UP_GUIDANCE,
  STANDARDS_FOOTER,
} from './agents/prompts/shared.js'

// Deterministic, container-free rendering + lenient coercion of the in-repo
// `blueprints/`/`spec/` artifacts (lifted out of the executor-harness image). Invoked
// from an agent's post-op: coerce the model's JSON, render the files, commit via the
// RepoFiles port. Pure functions — same input → same bytes.
export {
  type RenderedFile,
  coerceBlueprintService,
  moduleSlug,
  canonicalBlueprintJson,
  hashBlueprint,
  renderBlueprintFiles,
  renderBlueprintVersionFile,
  nextBlueprintVersion,
  coerceSpecDoc,
  dedupeSpecIds,
  renderSpecFiles,
  renderSpecFeatureFiles,
} from './repo-ops/render.js'
// Driver for a registered kind's pre/post-op hooks (plain TS over the checkout-free
// RepoFiles port). Here, not in @cat-factory/server, so the orchestration engine can
// run the ops without importing the HTTP layer.
export { runRepoOps } from './repo-ops/run.js'
// Built-in post-ops for migrated built-in kinds (blueprints/…): the deterministic render
// + commit lifted out of the executor-harness, keyed by the engine's built-in op map (NOT
// the registry, so they never leak into the custom-kind palette).
export { blueprintPostOp, specPostOp } from './repo-ops/builtin.js'

// The generic AI provisioning facade: a mixable provider registry + the base,
// runtime-neutral resolvers. Optional/heavier backends ship as their own packages
// (e.g. @cat-factory/provider-bedrock) and are mixed into a CompositeModelProvider.
export {
  CompositeModelProvider,
  CliInlineLanguageModel,
  type InlineCliRequest,
  type InlineCliResult,
  type InlineCliRunner,
  InstrumentedModelProvider,
  catFactoryObservability,
  type InlineObservabilityContext,
  type ModelResolver,
  type ProviderRegistry,
  anthropicResolver,
  baseProviderRegistry,
  cloudflareRestResolver,
  openAiCompatibleResolver,
  openAiResolver,
  DEEPSEEK_BASE_URL,
  DEFAULT_OPENAI_COMPATIBLE_BASE_URLS,
  isProxyableProvider,
  MOONSHOT_BASE_URL,
  OPENAI_BASE_URL,
  OPENROUTER_BASE_URL,
  QWEN_BASE_URL,
  resolveOpenAiCompatibleBaseUrl,
  type CachePolicy,
  cachedTokensFromUsage,
  inlineCacheProviderOptions,
  promptCacheParams,
  providerCachePolicy,
} from './providers/index.js'

export {
  FragmentLibraryService,
  type FragmentLibraryServiceDependencies,
} from './fragmentLibrary/FragmentLibraryService.js'
export {
  FragmentSourceService,
  type FragmentSourceServiceDependencies,
  type ResolveFragmentInstallationId,
} from './fragmentLibrary/FragmentSourceService.js'
export { DeterministicFragmentSelector } from './fragmentLibrary/DeterministicFragmentSelector.js'
export {
  LlmFragmentSelector,
  type LlmFragmentSelectorDependencies,
} from './fragmentLibrary/LlmFragmentSelector.js'
export {
  type ResolvedCatalogEntry,
  mergeCatalog,
  toSelectable,
  entryToFragment,
  selectDeterministic,
} from './fragmentLibrary/fragment-catalog.js'
export * as fragmentSourceLogic from './fragmentLibrary/fragment-source.logic.js'
