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
export {
  type AgentUserPromptOptions,
  appendedDirectivesFor,
  baseSystemPromptFor,
  systemPromptFor,
  userPromptFor,
} from './agents/catalog.js'
export { summaryOr } from './agents/kinds/built-in-results.js'
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
// Agent CAPABILITIES: the skills a kind applies and the tool servers (MCP) it may call.
// A deployment registers reusable definitions on the same injected registry and references
// them by id from any number of kinds, or declares one inline on a single kind. See
// `backend/docs/custom-agents.md` → "Capabilities: skills and tools".
export {
  type AgentKindSkillRef,
  type AgentKindToolRef,
  type BundledSkillDefinition,
  type NormalizedSkillRefs,
  bundledSkillToResolved,
  normalizeSkillRefs,
  normalizeToolRefs,
} from './agents/kinds/capabilities.js'
// Where the deployment's capability LAYER is read from when it is not this process's own registry
// (a mothership-mode node reads the mothership's, over `GET /internal/agent-kinds`). The kind
// catalog itself stays node-local: only the data half can cross a wire.
export {
  type AgentKindCapabilityView,
  type AgentKindSource,
  agentKindCapabilityViews,
  mergeDeclaredToolServers,
  mergeKindCapabilities,
  registryAgentKindSource,
} from './agents/kinds/source.js'
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
  DESIGN_IMAGES_TRAIT,
  INTERVIEW_GATE_TRAIT,
  REVIEW_SKILLS_TRAIT,
  BRIEF_STANDARDS_TRAIT,
  FOUNDATIONAL_CATALOG_TRAIT,
  FOUNDATIONAL_CONTRACTS_TRAIT,
  FOUNDATIONAL_CATALOG_GUIDANCE,
  FOUNDATIONAL_CONTRACTS_GUIDANCE,
  BINARY_OUTPUT_TRAIT,
  BINARY_OUTPUT_GUIDANCE,
  SPEC_AWARE_GUIDANCE,
  STANDARD_AGENT_TRAITS,
  traitsFor,
  hasTrait,
  traitGuidanceFor,
  standardsVerbosityFor,
} from './agents/kinds/traits.js'
// Per-agent-kind execution tuning (today: progress-guard knobs) folded into a container
// dispatch's job body. Loosen-only, so a kind's normal pattern isn't killed mid-progress.
export {
  type AgentTuning,
  type AgentGuardTuning,
  agentTuningFor,
  withComplexityAllowance,
} from './agents/kinds/tuning.js'
// Agent configuration-contribution catalog (the descriptors surfaced on task
// creation / inspector, frozen once the contributing step runs).
export {
  PLAYWRIGHT_E2E_TARGET_CONFIG_ID,
  CODER_FORK_DECISION_CONFIG_ID,
  CODER_REPRODUCTION_PROOF_CONFIG_ID,
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
// A bespoke system prompt SPLIT at the boundary a workspace override may cross — the shape the
// inline engine steps and the two bespoke container kinds declare their prompts in.
export { type BespokeSystemPrompt, composeBespokePrompt } from './agents/prompts/bespoke.js'
// The two bespoke CONTAINER prompts, the map collecting every bespoke-prompt kind, and the two
// resolvers that take a composed prompt apart and put it back together: `shippedBasePromptFor` is
// what a workspace override and a registered variant each replace (and what the prompt editor shows
// as the baseline), and `composedSystemPromptFor` is what a kind then actually sends.
export {
  BESPOKE_SYSTEM_PROMPTS,
  composedSystemPromptFor,
  MERGER_DIRECTIVES,
  MERGER_ROLE_PROMPT,
  MERGER_SYSTEM_PROMPT,
  ON_CALL_DIRECTIVES,
  ON_CALL_ROLE_PROMPT,
  ON_CALL_SYSTEM_PROMPT,
  shippedBasePromptFor,
} from './agents/prompts/bespoke-kinds.js'
// Agent-kind VARIANTS — an alternate prompt for an EXISTING kind, selected per step. Not a kind:
// the step keeps the base kind, so every behavioural decision is unchanged. See ./kinds/variants.
export {
  type AgentKindVariantDefinition,
  type AgentKindVariantPresentation,
  type AgentVariantApplication,
  type AppliedAgentVariant,
  applyAgentVariant,
} from './agents/kinds/variants.js'
// The inline engine steps' prompts keyed by agent kind, so the prompt EDITOR shows the text that
// actually runs (these kinds never reach `systemPromptFor`).
export {
  ARCHITECTURE_BRAINSTORM_REWORK_AGENT_KIND,
  CLARITY_REWORK_AGENT_KIND,
  INLINE_ENGINE_SYSTEM_PROMPTS,
  REQUIREMENTS_BRAINSTORM_REWORK_AGENT_KIND,
  REQUIREMENTS_REWORK_AGENT_KIND,
  REQUIREMENTS_WRITER_AGENT_KIND,
} from './agents/prompts/inline-engine.js'
// Requirements-review prompt text + its versioned-prompt registry.
export {
  REVIEW_PROMPT,
  REVIEW_SYSTEM_PROMPT,
  REWORK_PROMPT,
  REWORK_SYSTEM_PROMPT,
  WRITER_PROMPT,
  WRITER_SYSTEM_PROMPT,
} from './agents/prompts/requirements.js'
// Clarity-review (bug-report triage) prompt text.
export {
  CLARITY_REVIEW_PROMPT,
  CLARITY_REVIEW_SYSTEM_PROMPT,
  CLARITY_REWORK_PROMPT,
  CLARITY_REWORK_SYSTEM_PROMPT,
} from './agents/prompts/clarity.js'
// Brainstorm (structured-dialogue) prompt text.
export {
  ARCHITECTURE_BRAINSTORM_PROMPT,
  ARCHITECTURE_BRAINSTORM_REWORK_PROMPT,
  ARCHITECTURE_BRAINSTORM_REWORK_SYSTEM_PROMPT,
  ARCHITECTURE_BRAINSTORM_SYSTEM_PROMPT,
  REQUIREMENTS_BRAINSTORM_PROMPT,
  REQUIREMENTS_BRAINSTORM_REWORK_PROMPT,
  REQUIREMENTS_BRAINSTORM_REWORK_SYSTEM_PROMPT,
  REQUIREMENTS_BRAINSTORM_SYSTEM_PROMPT,
} from './agents/prompts/brainstorm.js'
export {
  type VersionedPrompt,
  type PromptId,
  PROMPT_VERSIONS,
  promptVersion,
  promptVersionLabel,
  promptVersionForKind,
  promptIdForKind,
} from './agents/kinds/versions.js'
export { KAIZEN_SYSTEM_PROMPT } from './agents/prompts/kaizen.js'
export {
  composeSystemPrompt,
  composeBlockSystemPrompt,
  isStandardsContextFile,
  standardsDeliveredAsFiles,
  STANDARDS_CONTEXT_INDEX_FILE,
  STANDARDS_CONTEXT_FILE_PREFIX,
  type ComposableBlock,
  type StandardsDelivery,
} from './agents/runtime/fragments.js'
export {
  type StandardPhase,
  STANDARD_PHASES,
  STANDARD_PHASE_BY_KIND,
  phaseForKind,
  standardSystemPrompt,
  renderStandardUserPrompt,
  renderLinkedContext,
  initiativePresetSection,
  CONTEXT_DIR,
  REFERENCE_SCREENSHOT_DIR,
  DESIGN_RENDER_DIR,
  GENERATED_BINARY_DIR,
  designImagesSection,
} from './agents/prompts/standard.js'
export { toolServersSection } from './agents/prompts/capabilities.js'
export {
  type AcceptanceAgentKind,
  ACCEPTANCE_AGENT_KINDS,
  acceptanceSystemPrompt,
  isAcceptanceKind,
  testApproachSection,
} from './agents/prompts/acceptance.js'
// The companion PAIRING vocabulary. The built-in catalog is exported for the tests and the
// snapshot projection; every LOOKUP is a method on `AgentKindRegistry`, which pre-loads it,
// so a deployment's own rework pair answers the same questions the built-ins do.
export {
  type CompanionDefinition,
  COMPANIONS,
  companionFor,
  companionTargets,
  isCompanionKind,
  isContainerBackedCompanion,
} from './agents/kinds/companions.js'
// Which kinds a pipeline may ESTIMATE-GATE. Shared by the pipeline-shape validation (builder save +
// run start) so the builder can't offer a gate the engine would refuse.
export { BUILTIN_GATABLE_KINDS, isGatableKind } from './agents/kinds/gatable.js'
// The ONE definition of "does this dispatch hand the agent a real checkout?", shared by the
// composite executor's ROUTING and the engine's preOp context preparation so the two can never
// disagree about whether an agent can read files or run git.
export {
  deliverableIsReply,
  dispatchDeliversCheckout,
  runsInContainer,
} from './agents/kinds/container-surface.js'
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
  DOC_FIXER_KIND,
  DOCUMENT_AGENT_KINDS,
  registerDocumentAgents,
  resolveDocumentTarget,
  type DocumentTarget,
} from './agents/kinds/document.js'
// The in-source comment maintainer (`code-commenter`), pre-loaded by `defaultAgentKindRegistry()`
// so it is a first-class kind in every deployment (Worker / Node / local) — the in-source-comments
// leg of the docs-refresh preset (diagrams / READMEs reuse `doc-writer`, business rules reuse
// `business-documenter`, so it is the one genuinely-new authoring capability the preset needs).
export {
  CODE_COMMENTER_KIND,
  CODE_COMMENTER_AGENT_KINDS,
  registerCodeCommenterAgent,
} from './agents/kinds/code-commenter.js'
// The app-owned initiative-preset registry factory: news an `InitiativePresetRegistry` (its class +
// the generic built-in live in kernel) and preloads the docs-refresh + tech-migration built-ins.
// This is the single place the built-ins are installed — no module-load side effect — so every
// facade (and every test) gets its own instance; a deployment registers extra presets by reference
// on the instance the composition root injects. Mirrors `defaultAgentKindRegistry()`.
export { defaultInitiativePresetRegistry } from './presets/registry.js'
// The Documentation-refresh initiative preset (initiative-presets slice 8), preloaded by
// `defaultInitiativePresetRegistry()` so the pilot preset is available in every deployment with no
// per-facade wiring — the two runtimes cannot drift on it. `detect` reuses slice 6's
// `detectDocsLayout`, `seedPlan` stamps per-item spawn decoration ONLY, and `phaseTemplate`
// enforces the plan shape via the generic ingest normalizer (never `seedPlan`).
export {
  DOCS_REFRESH_PRESET_ID,
  DOCS_REFRESH_PRESET,
  registerDocsRefreshPreset,
  docsReviewGates,
} from './presets/docs-refresh/preset.js'
// The Technological-migration initiative preset (tech-migration slice T8), preloaded by
// `defaultInitiativePresetRegistry()` so it is available in every deployment with no per-facade
// wiring — the two runtimes cannot drift on it. It composes the already-landed migration pieces:
// the `phaseTemplate` (five-phase methodology enforced by the generic ingest normalizer),
// `seedMigrationPlan` as `seedPlan` (T7 spawn decoration + confidence-case wiring), the T5
// `promptAdditions`, and the T4 `MIGRATION_FRAGMENT_IDS`. No probe.
export {
  TECH_MIGRATION_PRESET_ID,
  TECH_MIGRATION_PRESET,
  registerTechMigrationPreset,
} from './presets/tech-migration/preset.js'
// The canonical migration phase ids — the CONTRACT shared by the preset's `phaseTemplate`, its
// `promptAdditions`, `seedMigrationPlan`, and the migration e2e (T10). Re-exported so a consumer
// (notably the e2e's fake plan draft) references the ids by import rather than retyping a string
// that could silently drift out of the template the ingest normalizer matches on.
export { MIGRATION_PHASE_IDS, MIGRATION_PHASE_ID_ORDER } from './presets/tech-migration/phases.js'
export type { MigrationPhaseId } from './presets/tech-migration/phases.js'
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
  // WS1 items 2–3: resolve a kind's effective template given an optional workspace-linked template
  // body — the single seam the doc-authoring prompts AND the doc-quality gate provider share.
  // (`parseTemplateDocument` stays module-internal — `resolveDocTemplate` is the public entry.)
  resolveDocTemplate,
  requiredSectionTitles,
  renderTemplateSkeleton,
} from './agents/kinds/doc-templates.js'
export {
  INITIATIVE_BREAKDOWN_KIND,
  INITIATIVE_AGENT_KINDS,
  codebaseAnalysisLines,
  initiativeAnalystUserPrompt,
  initiativePlannerUserPrompt,
  registerInitiativeAgents,
} from './agents/kinds/initiative.js'
export { BLUEPRINTS_AGENT_KIND, SPEC_WRITER_AGENT_KIND } from './agents/kinds/spec-blueprints.js'
// The BUILT-IN CONTAINER kinds, as ordinary registry entries (the last slice of the agent-kind
// strangler): their ids live beside their definitions, exactly as the blueprints/spec-writer and
// inline-reviewer ids do, and orchestration re-exports the ones the engine names.
export {
  ANALYSIS_AGENT_KIND,
  BUILT_IN_CONTAINER_AGENT_KINDS,
  IMPLEMENTER_AGENT_KIND,
  MERGER_AGENT_KIND,
  TESTER_AGENT_KIND,
  registerBuiltInContainerAgents,
} from './agents/kinds/built-in-container.js'
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
  SPIKE_AGENT_KIND,
  SPIKE_AGENT_KINDS,
  spikeFindings,
  type SpikeFindings,
  registerSpikeAgent,
} from './agents/kinds/spike.js'
export { SKILL_AGENT_KIND, SKILL_AGENT_KINDS, registerSkillAgent } from './agents/kinds/skill.js'
export {
  MEDIA_AGENT_KINDS,
  MEDIA_GENERATOR_AGENT_KIND,
  registerMediaAgent,
} from './agents/kinds/media.js'
export {
  FORK_PROPOSER_KIND,
  FORK_PROPOSER_AGENT_KINDS,
  FORK_PROPOSER_SYSTEM_PROMPT,
  forkProposal,
  type ForkProposalOutput,
  registerForkProposerAgent,
} from './agents/kinds/fork-proposer.js'
export {
  PR_PRIOR_REVIEW_CONTEXT_FILE,
  PR_REVIEWER_KIND,
  PR_REVIEWER_AGENT_KINDS,
  PR_REVIEWER_SYSTEM_PROMPT,
  prReview,
  type PrReviewOutput,
  registerPrReviewerAgent,
  renderPriorReviewContext,
  resolvePrNumber,
} from './agents/kinds/pr-reviewer.js'
export {
  CHALLENGE_INVESTIGATOR_KIND,
  CHALLENGE_INVESTIGATOR_AGENT_KINDS,
  CHALLENGE_INVESTIGATOR_SYSTEM_PROMPT,
  prReviewChallenge,
  type PrReviewChallengeOutput,
  registerChallengeInvestigatorAgent,
} from './agents/kinds/challenge-investigator.js'
export {
  FORK_CHAT_AGENT_KIND,
  FORK_CHAT_SYSTEM_PROMPT,
  type ForkChatGrounding,
  renderForkChatPrompt,
} from './agents/prompts/fork-decision.js'
export { JUDGE_SYSTEM_PROMPT, renderJudgePrompt } from './agents/prompts/judge.js'
export {
  BUG_HUNT_AGENT_KIND,
  BUG_HUNT_SYSTEM_PROMPT,
  renderBugHuntPrompt,
} from './agents/prompts/bug-hunt.js'
export {
  FRAGMENT_TITLE_AGENT_KIND,
  FRAGMENT_TITLE_SYSTEM_PROMPT,
  renderFragmentTitlePrompt,
} from './agents/prompts/fragment-title.js'
export {
  FRAGMENT_BRIEF_AGENT_KIND,
  FRAGMENT_BRIEF_SYSTEM_PROMPT,
  renderFragmentBriefPrompt,
} from './agents/prompts/fragment-brief.js'
export {
  ENVIRONMENT_ANALYST_KIND,
  ENVIRONMENT_ANALYST_AGENT_KINDS,
  environmentRecipeDraft,
  type EnvironmentRecipeDraft,
  registerEnvironmentAnalystAgent,
} from './agents/kinds/environment-analyst.js'
export {
  DEPLOY_FIXER_AGENT_KIND,
  DEPLOY_FIXER_AGENT_KINDS,
  DEPLOY_FIXER_ROLE_PROMPT,
  DEPLOY_FIXER_DIRECTIVES,
  DEPLOY_FAILURE_PRIOR_KIND,
  registerDeployFixerAgent,
} from './agents/kinds/deploy-fixer.js'
export {
  REPRO_TEST_KIND,
  REPRO_TEST_AGENT_KINDS,
  reproTestOutcome,
  type ReproTestOutcome,
  registerReproTestAgent,
  BUG_FIX_GUIDANCE,
  bugFixGuidanceFor,
} from './agents/kinds/repro-test.js'
export {
  RALPH_AGENT_KIND,
  RALPH_AGENT_KINDS,
  RALPH_VALIDATION_COMMAND_CONFIG_ID,
  RALPH_MAX_ITERATIONS_CONFIG_ID,
  RALPH_DEFAULT_MAX_ITERATIONS,
  ralphConfigContributions,
  registerRalphAgent,
} from './agents/kinds/ralph.js'
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
  EFFORT_REPORT_FILE,
  EFFORT_REPORT_GUIDANCE,
  EXECUTION_SANDBOX_GUIDANCE,
  FINAL_ANSWER_IN_REPLY,
  FOLLOW_UP_GUIDANCE,
  FOLLOW_UPS_FILE,
  FRAGMENT_ADHERENCE_GUIDANCE,
  INLINE_PANEL_SURFACE,
  NO_ASSUMED_PRODUCT,
  PLATFORM_IS_NOT_THE_PRODUCT,
  PR_DESCRIPTION_FILE,
  PR_DESCRIPTION_GUIDANCE,
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
  promoteRequirementStates,
  clearAspirationalTag,
} from './repo-ops/render.js'
// Driver for a registered kind's pre/post-op hooks (plain TS over the checkout-free
// RepoFiles port). Here, not in @cat-factory/server, so the orchestration engine can
// run the ops without importing the HTTP layer.
export { runRepoOps } from './repo-ops/run.js'
// Built-in post-ops for migrated built-in kinds (blueprints/…): the deterministic render
// + commit lifted out of the executor-harness, keyed by the engine's built-in op map (NOT
// the registry, so they never leak into the custom-kind palette).
export { blueprintPostOp, specPostOp, specPromotionPostOp } from './repo-ops/builtin.js'
// Checkout-free reassembly of the SHARDED in-repo `spec/` tree. Lives here (not in
// @cat-factory/server, which is above both) because THREE layers read it: the SPA's
// service-spec view (server), the tester-driven promotion post-op (below), and the PR
// verification report's criterion → evidence join (orchestration).
export { readServiceSpec } from './repo-ops/readServiceSpec.js'
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
  type InlineCliTelemetry,
  // The marker that decides which of the two inline-telemetry producers owns a model's rows.
  // Exported alongside `InstrumentedModelProvider` for the same reason: a facade's wiring test
  // asserts that a self-reporting model came back UNWRAPPED.
  reportsOwnLlmCalls,
  type SelfReportingLanguageModel,
  InstrumentedModelProvider,
  catFactoryObservability,
  type InlineObservabilityContext,
  type WorkspaceBodiesGate,
  VendorConcurrencyLimiter,
  // Exported for the same reason `InstrumentedModelProvider` is: a facade's wiring test asserts
  // on the wrapper it composed, and the ORDER of these two around a resolved model is
  // load-bearing (`wrapResolverWithTelemetry`).
  LimitedModelProvider,
  limitModelProvider,
  vendorConcurrencyLimiterFromEnv,
  type ModelResolver,
  type ProviderRegistry,
  MODEL_SUPPORT_DOCS,
  anthropicResolver,
  baseProviderRegistry,
  cloudflareRestResolver,
  openAiCompatibleResolver,
  openAiResolver,
  cloudflareRestBaseUrl,
  DEEPSEEK_BASE_URL,
  DEFAULT_OPENAI_COMPATIBLE_BASE_URLS,
  isDirectProvider,
  isOpenAiCompatibleProvider,
  isOperatorHostedGateway,
  isProxyableProvider,
  MOONSHOT_BASE_URL,
  OPENAI_BASE_URL,
  OPENAI_COMPATIBLE_PROVIDERS,
  OPENROUTER_BASE_URL,
  OPERATOR_HOSTED_GATEWAYS,
  QWEN_BASE_URL,
  resolveOpenAiCompatibleBaseUrl,
  type DirectProvider,
  type OpenAiCompatibleProvider,
  type OperatorHostedGateway,
  UI_CONFIGURABLE_DIRECT_PROVIDERS,
  XAI_BASE_URL,
  type CachePolicy,
  type InputTokenClasses,
  readInputTokenClasses,
  inlineCacheProviderOptions,
  promptCacheParams,
  providerCachePolicy,
} from './providers/index.js'

export {
  FragmentLibraryService,
  type FragmentLibraryServiceDependencies,
  type FragmentStandardsVerbosity,
  type ResolveBodiesOptions,
} from './fragmentLibrary/FragmentLibraryService.js'
export {
  FragmentBriefService,
  type FragmentBriefCandidate,
  type FragmentBriefServiceDependencies,
} from './fragmentLibrary/FragmentBriefService.js'
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
  LlmFragmentBriefGenerator,
  type LlmFragmentBriefGeneratorDependencies,
} from './fragmentLibrary/LlmFragmentBriefGenerator.js'
export {
  type CatalogBriefScope,
  type ResolvedCatalogEntry,
  mergeCatalog,
  toSelectable,
  entryToFragment,
  selectDeterministic,
} from './fragmentLibrary/fragment-catalog.js'
export * as fragmentSourceLogic from './fragmentLibrary/fragment-source.logic.js'

// ---- repo-sourced Claude Skills library (ADR 0024) ----
export {
  SkillSourceService,
  type SkillSourceServiceDependencies,
  type ResolveSkillInstallationId,
} from './skillLibrary/SkillSourceService.js'
export {
  SkillCatalogService,
  type SkillCatalogServiceDependencies,
} from './skillLibrary/SkillCatalogService.js'
export { SkillRunResolver, type ResolvedSkillForRun } from './skillLibrary/SkillRunResolver.js'
export * as skillSourceLogic from './skillLibrary/skill-source.logic.js'

// ---- foundational services (backend/docs/adr/0031-foundational-services.md) ----
export {
  FoundationalServiceCatalogService,
  type FoundationalServiceCatalogDependencies,
} from './foundationalServices/FoundationalServiceCatalogService.js'
export {
  FoundationalServiceSourceService,
  type FoundationalServiceSourceServiceDependencies,
  type ResolveFoundationalInstallationId,
} from './foundationalServices/FoundationalServiceSourceService.js'
export { FoundationalServiceRunResolver } from './foundationalServices/FoundationalServiceRunResolver.js'
export { assertValidDefinition } from './foundationalServices/contract-validation.js'
export { mergeFoundationalTiers } from './foundationalServices/foundational-catalog.js'
export * as foundationalSourceLogic from './foundationalServices/foundational-source.logic.js'
export {
  syncRepoSource,
  probeRepoSourceStatus,
  normalizeDirPath,
  type RepoSourceCoords,
  type RepoSourceSyncOutcome,
  type RepoSourceStatus,
  type ReconcileContext,
  type ReconcileResult,
  type SyncRepoSourceParams,
} from './repoSourceSync/repo-source-sync.js'
export {
  createTierInstallationResolvers,
  type TierInstallationResolverDependencies,
  type TierInstallationResolvers,
} from './repoSourceSync/tier-installation-resolver.js'
