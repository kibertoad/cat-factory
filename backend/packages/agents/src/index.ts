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
// App-owned agent-kind registry (mirrors the backend-registries pilot): the composition
// root news ONE `AgentKindRegistry` (pre-loaded with the built-ins by
// `defaultAgentKindRegistry()`), threads it through `CoreDependencies`, and a deployment
// registers extra kinds by reference on the injected instance. No module-global, no
// `clear*()`, no external-adapter module-identity gotcha.
export {
  type AgentKindDefinition,
  AgentKindRegistry,
  defaultAgentKindRegistry,
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
// of the service's best-practice fragments; `doc-aware` folds the document-task writing
// style fragments the same way; `spec-aware` appends the in-repo-spec guidance.
export {
  type AgentTrait,
  type AgentTraitDefinition,
  CODE_AWARE_TRAIT,
  DOC_AWARE_TRAIT,
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
  TESTER_QC_SYSTEM_PROMPT,
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
// Per-`DocKind` document templates: the single source of truth for a kind's expected shape,
// woven into the outliner/writer prompts and (later) read by the doc-quality gate. The
// built-in `DOC_TEMPLATES` are the fallback; a deployment overrides via `registerDocTemplate`.
// The public surface is the registry + the two cross-consumer helpers: `requiredSectionTitles`
// (the WS4 doc-quality gate's source of truth) and `renderTemplateSkeleton` (for override
// authors to preview a template). The prompt-weaving helpers (`templateStructureLine` /
// `templateOutlineGuidance` / `templateSkeletonGuidance`) stay module-private to `document.ts`.
export {
  type DocTemplate,
  type DocTemplateSection,
  DOC_TEMPLATES,
  registerDocTemplate,
  registerDocTemplates,
  clearRegisteredDocTemplates,
  docTemplateFor,
  requiredSectionTitles,
  renderTemplateSkeleton,
} from './agents/kinds/doc-templates.js'
export {
  INITIATIVE_BREAKDOWN_KIND,
  INITIATIVE_AGENT_KINDS,
  registerInitiativeAgents,
} from './agents/kinds/initiative.js'
export {
  READ_ONLY_AGENT_KINDS,
  READ_ONLY_GUARDRAIL,
  isReadOnlyAgentKind,
} from './agents/kinds/read-only.js'
export {
  BUG_INVESTIGATOR_KIND,
  BUG_INVESTIGATOR_AGENT_KINDS,
  bugInvestigation,
  type BugInvestigation,
  registerBugInvestigatorAgent,
} from './agents/kinds/bug-investigator.js'
export {
  REPRO_TEST_KIND,
  REPRO_TEST_AGENT_KINDS,
  reproTestOutcome,
  type ReproTestOutcome,
  registerReproTestAgent,
  BUG_FIX_GUIDANCE,
  bugFixGuidanceFor,
} from './agents/kinds/repro-test.js'
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
// Initiative tracker helpers: lenient plan coercion + the deterministic render/commit of
// the in-repo `docs/initiatives/<slug>/` projection (the blueprint pattern applied to the
// initiative entity). Driven from the engine's committer step handler, not a postOp — the
// tracker renders the DB entity, which a RepoOp context doesn't carry.
export {
  coerceInitiativePlan,
  canonicalInitiativeJson,
  hashInitiative,
  initiativeContentView,
  renderInitiativeFiles,
  renderInitiativeTrackerMarkdown,
  parseInitiativeVersionFile,
  commitInitiativeTracker,
} from './repo-ops/initiative.js'

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
