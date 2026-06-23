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
  clearRegisteredAgentKinds,
} from './agents/kinds/registry.js'
// Agent capability traits (standard + custom). `code-aware` gates the engine's folding
// of the service's best-practice fragments; `spec-aware` appends the in-repo-spec guidance.
export {
  type AgentTrait,
  type AgentTraitDefinition,
  CODE_AWARE_TRAIT,
  SPEC_AWARE_TRAIT,
  SPEC_AWARE_GUIDANCE,
  STANDARD_AGENT_TRAITS,
  registerAgentTrait,
  registerAgentTraits,
  registeredAgentTrait,
  clearRegisteredAgentTraits,
  traitsFor,
  hasTrait,
  traitGuidanceFor,
} from './agents/kinds/traits.js'
// Agent configuration-contribution catalog (the descriptors surfaced on task
// creation / inspector, frozen once the contributing step runs).
export {
  TESTER_ENVIRONMENT_CONFIG_ID,
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
export { REVIEW_SYSTEM_PROMPT, REWORK_SYSTEM_PROMPT } from './agents/prompts/requirements.js'
// Clarity-review (bug-report triage) prompt text.
export {
  CLARITY_REVIEW_SYSTEM_PROMPT,
  CLARITY_REWORK_SYSTEM_PROMPT,
} from './agents/prompts/clarity.js'
export {
  type VersionedPrompt,
  type PromptId,
  PROMPT_VERSIONS,
  promptVersion,
  promptVersionLabel,
} from './agents/kinds/versions.js'
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
} from './agents/kinds/companions.js'
export { companionSystemPrompt } from './agents/prompts/companion.js'
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

// The generic AI provisioning facade: a mixable provider registry + the base,
// runtime-neutral resolvers. Optional/heavier backends ship as their own packages
// (e.g. @cat-factory/provider-bedrock) and are mixed into a CompositeModelProvider.
export {
  CompositeModelProvider,
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
  MOONSHOT_BASE_URL,
  OPENAI_BASE_URL,
  OPENROUTER_BASE_URL,
  QWEN_BASE_URL,
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
