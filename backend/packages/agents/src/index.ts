export { AiAgentExecutor, type AiAgentExecutorDependencies } from './agents/AiAgentExecutor.js'
export {
  type InlineWebSearchOptions,
  DEFAULT_INLINE_WEB_SEARCH_KINDS,
  DEFAULT_INLINE_WEB_SEARCH_MAX_USES,
  webResearchGuidanceFor,
  inlineWebSearchOptionsFromEnv,
  providerWebSearchTools,
} from './agents/web-search.js'
export {
  type AgentModelConfig,
  type AgentRouting,
  type StepModelResolvers,
  type StepModelInputs,
  resolveAgentConfig,
  resolveStepModelRef,
} from './agents/agent-routing.js'
export { systemPromptFor, userPromptFor } from './agents/agent-catalog.js'
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
  clearRegisteredAgentKinds,
} from './agents/registry.js'
export {
  type VersionedPrompt,
  type PromptId,
  PROMPT_VERSIONS,
  REVIEW_SYSTEM_PROMPT,
  REWORK_SYSTEM_PROMPT,
  promptVersion,
  promptVersionLabel,
} from './agents/prompt-versions.js'
export {
  composeSystemPrompt,
  composeBlockSystemPrompt,
  type ComposableBlock,
} from './agents/prompt-fragments.js'
export {
  type StandardPhase,
  STANDARD_PHASES,
  STANDARD_PHASE_BY_KIND,
  phaseForKind,
  standardSystemPrompt,
  renderStandardUserPrompt,
} from './agents/standard-prompts.js'
export {
  type AcceptanceAgentKind,
  ACCEPTANCE_AGENT_KINDS,
  acceptanceSystemPrompt,
  isAcceptanceKind,
  testApproachSection,
} from './agents/acceptance-prompts.js'
export {
  type CompanionDefinition,
  COMPANIONS,
  isCompanionKind,
  companionFor,
  companionTargets,
} from './agents/companions.js'
export { companionSystemPrompt } from './agents/companion-prompts.js'
export { MOCK_AGENT_KIND, isMockKind, mockSystemPrompt } from './agents/mock-prompts.js'
export {
  type BusinessLogicAgentKind,
  BUSINESS_LOGIC_AGENT_KINDS,
  BUSINESS_DOCUMENTER_KIND,
  BUSINESS_REVIEWER_KIND,
  BUSINESS_LOGIC_DOCS_DIR,
  isBusinessLogicKind,
  businessLogicSystemPrompt,
} from './agents/business-logic-prompts.js'
export { PLATFORM_DELIVERY_CONTRACT } from './agents/ci-gate.js'

// The generic AI provisioning facade: a mixable provider registry + the base,
// runtime-neutral resolvers. Optional/heavier backends ship as their own packages
// (e.g. @cat-factory/provider-bedrock) and are mixed into a CompositeModelProvider.
export {
  CompositeModelProvider,
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
  type ResolvedCatalogEntry,
  mergeCatalog,
  toSelectable,
  entryToFragment,
  selectDeterministic,
} from './fragmentLibrary/fragment-catalog.js'
export * as fragmentSourceLogic from './fragmentLibrary/fragment-source.logic.js'
