export { AiAgentExecutor, type AiAgentExecutorDependencies } from './agents/AiAgentExecutor'
export {
  type AgentModelConfig,
  type AgentRouting,
  resolveAgentConfig,
} from './agents/agent-routing'
export { systemPromptFor, userPromptFor } from './agents/agent-catalog'
export {
  type VersionedPrompt,
  type PromptId,
  PROMPT_VERSIONS,
  REVIEW_SYSTEM_PROMPT,
  promptVersion,
  promptVersionLabel,
} from './agents/prompt-versions'
export {
  composeSystemPrompt,
  composeBlockSystemPrompt,
  type ComposableBlock,
} from './agents/prompt-fragments'
export {
  type StandardPhase,
  STANDARD_PHASES,
  STANDARD_PHASE_BY_KIND,
  phaseForKind,
  standardSystemPrompt,
  renderStandardUserPrompt,
} from './agents/standard-prompts'
export {
  type AcceptanceAgentKind,
  ACCEPTANCE_AGENT_KINDS,
  acceptanceSystemPrompt,
  isAcceptanceKind,
  testApproachSection,
} from './agents/acceptance-prompts'
export { MOCK_AGENT_KIND, isMockKind, mockSystemPrompt } from './agents/mock-prompts'
export {
  type BusinessLogicAgentKind,
  BUSINESS_LOGIC_AGENT_KINDS,
  BUSINESS_DOCUMENTER_KIND,
  BUSINESS_REVIEWER_KIND,
  BUSINESS_LOGIC_DOCS_DIR,
  isBusinessLogicKind,
  businessLogicSystemPrompt,
} from './agents/business-logic-prompts'
export { CI_RETRY_SANITY_CHECK } from './agents/ci-gate'

export {
  FragmentLibraryService,
  type FragmentLibraryServiceDependencies,
} from './fragmentLibrary/FragmentLibraryService'
export {
  FragmentSourceService,
  type FragmentSourceServiceDependencies,
  type ResolveFragmentInstallationId,
} from './fragmentLibrary/FragmentSourceService'
export { DeterministicFragmentSelector } from './fragmentLibrary/DeterministicFragmentSelector'
export {
  type ResolvedCatalogEntry,
  mergeCatalog,
  toSelectable,
  entryToFragment,
  selectDeterministic,
} from './fragmentLibrary/fragment-catalog'
export * as fragmentSourceLogic from './fragmentLibrary/fragment-source.logic'
