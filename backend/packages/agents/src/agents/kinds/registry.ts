import type {
  AgentConfigDescriptor,
  AgentDispatchContext,
  AgentKind,
  AgentRunContext,
  AgentRunResult,
  AgentStepSpec,
  AgentUserPromptBuilder,
  McpServerDefinition,
  RepoOp,
  RunnerJobResult,
} from '@cat-factory/kernel'
import type { AgentKindSkillRef, AgentKindToolRef, BundledSkillDefinition } from './capabilities.js'
import { normalizeSkillRefs, normalizeToolRefs } from './capabilities.js'
import type { AgentPresentation } from '@cat-factory/contracts'
import type { AgentTrait, AgentTraitDefinition } from './traits.js'
import { STANDARD_TRAIT_DEFINITIONS } from './traits.js'
import type { CompanionDefinition } from './companions.js'
import { COMPANIONS } from './companions.js'
import type { AgentTuning } from './tuning.js'
import type { AgentKindVariantDefinition } from './variants.js'
import type { StructuredOutput } from './structured-output.js'
import { registerBugInvestigatorAgent } from './bug-investigator.js'
import { registerForkProposerAgent } from './fork-proposer.js'
import { registerPrReviewerAgent } from './pr-reviewer.js'
import { registerChallengeInvestigatorAgent } from './challenge-investigator.js'
import { registerDeployFixerAgent } from './deploy-fixer.js'
import { registerReproTestAgent } from './repro-test.js'
import { registerRalphAgent } from './ralph.js'
import { registerDocumentAgents } from './document.js'
import { registerCodeCommenterAgent } from './code-commenter.js'
import { registerInitiativeAgents } from './initiative.js'
import { registerSpecBlueprintAgents } from './spec-blueprints.js'
import { registerEnvironmentAnalystAgent } from './environment-analyst.js'
import { registerSpikeAgent } from './spike.js'
import { registerSkillAgent } from './skill.js'
import { registerMediaAgent } from './media.js'
import { registerBuiltInContainerAgents } from './built-in-container.js'

// Installation-level extension point for custom agent kinds, mirroring the
// model-provider registry seam (`registerModelRegistry` / `@cat-factory/provider-bedrock`).
// A deployment — e.g. a proprietary org package — teaches the prompt catalog a new
// agent kind by registering it once at startup (an import side effect); every
// `systemPromptFor` / `userPromptFor` call and the Worker's executor routing then
// pick it up, without the core packages knowing the kind exists. The agent-kind id
// is already an open string everywhere (pipelines, steps, model defaults), so a
// registered kind needs no schema change — only its role/prompt and (optionally) its
// container requirement.

export interface AgentKindDefinition {
  /** The free-form agent-kind id used in pipelines and steps (e.g. `security-auditor`). */
  kind: AgentKind
  /**
   * The system prompt (role) for this kind. A function form receives the kind id so a
   * single definition object can serve a family of related kinds.
   *
   * OPTIONAL, and omitting it means one specific thing: the kind's role text already has an
   * owner further up `baseSystemPromptFor` (a standard-phase track, the tester/fixer track, a
   * companion, one of the bespoke `{ role, directives }` prompts). That is the case for the
   * BUILT-IN kinds registered here purely to declare their dispatch shape: a copy on the
   * definition would be a second source of truth for text the track already resolves, and the
   * track wins in `baseSystemPromptFor` regardless, so the copy would be dead the day it drifted.
   * A kind a DEPLOYMENT registers always sets it: nothing else knows its role.
   */
  systemPrompt?: string | ((kind: AgentKind) => string)
  /**
   * Optional custom user-prompt builder, REPLACING the generic block-context prompt. When
   * omitted the kind uses the generic user prompt (block context + prior pipeline outputs),
   * exactly like any other non-standard-phase kind. Human revision feedback is appended
   * automatically. See {@link userPromptSuffix} for the additive form.
   */
  userPrompt?: AgentUserPromptBuilder
  /**
   * Optional task instructions APPENDED to the generic block-context prompt, for a kind that
   * needs everything the generic prompt carries (the run's evidence, the prior agents' output)
   * plus its own closing instruction — the `on-call` agent's "you are on the base branch, here
   * is how to find the merged commit, answer as JSON" is the shape.
   *
   * Deliberately a separate field rather than a `userPrompt` that calls the generic builder:
   * the generic builder is reached THROUGH this registry, so a kind calling it would recurse,
   * and the wrapper sections (an initiative preset's steering, a reusable operation's
   * parameters) would be folded in twice. Ignored when {@link userPrompt} is set, which
   * replaces the generic prompt outright.
   *
   * It ends the prompt UNCONDITIONALLY: `userPromptFor` appends it after the revision feedback
   * and the injected context files, both of which append too. That ordering is the field's whole
   * value for a reply-shape instruction ("respond with ONLY a JSON object"), which a revision
   * re-run would otherwise bury behind the reviewer's comments.
   */
  userPromptSuffix?: AgentUserPromptBuilder
  /**
   * When true this kind needs a real checkout (clone/edit/commit/PR) and must run in a
   * container rather than as a one-shot inline LLM call — see the Worker's
   * `CompositeAgentExecutor`. Defaults to false (an inline LLM agent). NOTE: a container
   * kind ALSO needs harness support for its dispatch endpoint; inline kinds work
   * end-to-end with no harness changes.
   */
  requiresContainer?: boolean
  /**
   * When true this container kind fans out across the block's connected involved-service
   * repos: the executor resolves the peer checkouts and threads them (+ the multi-repo
   * prompt section) into the dispatch, so the harness clones the primary repo PLUS every
   * peer as sibling checkouts. Used by cross-service kinds (e.g. the read-only
   * `bug-investigator`). Defaults to false (single-repo). Only meaningful for a container
   * kind — see {@link AgentKindRegistry.fansOutMultiRepo}.
   */
  fanOutMultiRepo?: boolean
  /**
   * Optional one-clause reason this kind should reach for web search, phrased to
   * complete "Use it mainly to …" (e.g. "verify the vendor's current API contract
   * before generating a client"). When web search is enabled for the deployment, this
   * is folded into the kind's web-search guidance so a proprietary kind gets a nudge
   * tailored to its job — without the shared library needing to know the kind exists.
   * Omitted ⇒ the generic "verify a fact that changes" hint. See `webResearchGuidanceFor`.
   */
  webResearchHint?: string
  /**
   * Task-level configuration parameters this kind contributes (see the agent-config
   * contracts). When a pipeline that includes this kind is selected for a task, these
   * descriptors are surfaced on task creation + the inspector, editable until the
   * kind's step starts. Each descriptor's `agentKind` should match this `kind` so the
   * freeze targets the right step. Omitted ⇒ the kind contributes no config.
   */
  configContributions?: AgentConfigDescriptor[]
  /**
   * Capability traits this kind carries (see ./traits). `code-aware` makes the engine
   * fold the running service's selected best-practice fragments into the agent's prompt;
   * `spec-aware` appends the in-repo-spec reading guidance. Deployments can also assign
   * their own traits registered via `registry.registerTrait`. Omitted ⇒ no traits.
   */
  traits?: AgentTrait[]
  /**
   * How this kind receives the best-practice standards its `code-aware`/`doc-aware` trait
   * resolved.
   *
   * - `prompt` (default) — folded into the system prompt, so they are always in context. Right
   *   for a kind that does the work itself, in one context.
   * - `context-files` — NOT folded; the kind's own preOp writes them as `.cat-context/` files
   *   and its prompt points the agent at them. Right for a kind that DELEGATES the work to
   *   subagents: an agentic loop re-sends its prompt on every turn, so folding charges the
   *   delegating agent for every standard on every one of its turns while the subagents that
   *   actually apply them never receive them. A kind choosing this MUST write the files itself
   *   (see `prReviewerStandardsPreOp`) and say where they are — the engine only stops folding.
   *
   * - `none` — this kind receives no standards at all. Right for a kind that JUDGES rather than
   *   produces (`merger` scores a diff's complexity/risk/impact): a house coding standard has no
   *   bearing on that score, and folding it in charges every assessment for text the assessment
   *   never applies.
   *
   * Omitted ⇒ `prompt`.
   */
  standardsDelivery?: 'prompt' | 'context-files' | 'none'
  /**
   * Per-kind execution tuning folded into a container dispatch's job body (today the
   * progress-guard knobs). Lets a custom kind whose normal pattern differs from the
   * default loosen a guard so it isn't killed mid-progress. The knobs are loosen-only:
   * the harness clamps each override up to its base, so a custom kind can only raise a
   * limit, never tighten one. Omitted ⇒ the kind inherits the harness defaults. See
   * ./tuning.
   */
  tuning?: AgentTuning
  /**
   * Whether a pipeline may ESTIMATE-GATE a step of this kind — skip it at runtime when the task
   * estimate an earlier `task-estimator` produced falls below the step's thresholds. Set it for a
   * kind whose output later steps read as CONTEXT (a design proposal, a research note, an extra
   * verification pass); leave it off for one some other mechanism reads STRUCTURALLY, whose absence
   * would break rather than merely thin the run.
   *
   * Omitted ⇒ NOT gatable: an unconditional step is the safe default, and a kind that would break
   * when skipped must not become skippable by an author forgetting to think about it. See
   * ./gatable for the built-in set and the reasoning behind each exclusion.
   */
  gatable?: boolean
  /**
   * The optional LLM step's execution surface + output/clone spec (inline, or a
   * container explore/coding run). Present ⇒ the kind runs an agent step; omitted ⇒ the
   * kind is pure pre/post-op work (no LLM). A container surface implies the kind needs a
   * checkout — see {@link registeredKindRequiresContainer}, which now also derives the
   * container requirement from this — so `requiresContainer` need not be set alongside it.
   */
  agent?: AgentStepSpec
  /**
   * Schema-driven structured output (see {@link defineStructuredOutput}). When present and the
   * author didn't set `agent.output` by hand, `registerAgentKind` derives `agent.output` from
   * `structuredOutput.spec` — so a structured kind declares ONE valibot schema instead of a
   * hand-written `shapeHint` string PLUS a lenient coercer. The kind's post-ops / step-resolver
   * read the typed parser back via {@link registeredStructuredOutput}. Omitted ⇒ no schema
   * (a prose kind, or one that sets `agent.output.shapeHint` by hand).
   */
  structuredOutput?: StructuredOutput<unknown>
  /**
   * Map a finished container job onto the engine's {@link AgentRunResult} — the kind's own
   * answer to "what domain channel does my structured reply belong in".
   *
   * A registered kind normally needs none: its parsed JSON surfaces on `result.custom` for its
   * post-op to render from. The BUILT-IN kinds do, because the engine reads their output through
   * a typed channel it acts on (`mergeAssessment` gates the real merge, `testReport` greenlights
   * or loops the fixer, `spec` is sharded into the repo), and those coercions are deliberately
   * CONSERVATIVE: a garbage merge score reads as "severe" so it routes to a human rather than
   * auto-merging. Declaring the mapping here is what let the executor's parallel
   * `agentKind === …` coercion chain collapse into one registry lookup.
   *
   * Called only when the job returned a parsed `custom` payload. Omitted ⇒ the raw JSON is
   * surfaced on `custom`.
   */
  mapStructuredResult?: (result: RunnerJobResult) => AgentRunResult
  /**
   * Deterministic backend operations run BEFORE the agent step (over a checkout-free
   * {@link RepoOp} context): read a baseline artifact into the prompt, etc. Plain TS,
   * runs on the backend — never in the container. Omitted ⇒ no pre-op.
   */
  preOps?: RepoOp[]
  /**
   * Deterministic backend operations run AFTER the agent step, consuming its structured
   * result: render artifact files and commit them via the RepoFiles port (the
   * blueprint/spec renderers live in `repo-ops/render.ts`). Plain TS — never in the
   * container. Omitted ⇒ no post-op.
   */
  postOps?: RepoOp[]
  /**
   * Skills this kind applies on every run — its procedural playbooks. Each ref is a bundled
   * skill registered on this registry (by id), an inline bundled skill (shipped with the kind),
   * or a `{ catalogSkillId }` reference to an account-tier repo-synced skill. The engine resolves
   * them at dispatch onto `AgentRunContext.skills`, and the container executor installs them
   * harness-aware — natively for claude-code, into `.cat-context/skill/` for Pi/codex.
   *
   * Distinct from the built-in `skill` KIND, which runs ONE skill picked per step
   * (`stepOptions.skillId`): this is a kind saying "my work is always done this way". A step
   * that picks a skill on a kind that also declares some runs both (deduplicated by id).
   * Omitted ⇒ the kind applies no skills of its own.
   */
  skills?: AgentKindSkillRef[]
  /**
   * Tool servers (MCP) this kind may call — a registered server id or an inline
   * {@link McpServerDefinition}. The engine resolves them at dispatch onto
   * `AgentRunContext.toolServers`, the executor threads their configuration (and any resolved
   * credentials) into the job body, and the harness wires them into the agent CLI.
   *
   * A server the running harness cannot serve (Pi has no MCP client) or whose required
   * credential does not resolve is DROPPED and stated in the prompt, never silently missing.
   * Omitted ⇒ the kind gets the harness's built-in tools only.
   */
  toolServers?: AgentKindToolRef[]
  /**
   * Frontend display metadata (label / icon / colour / category / result view). The
   * server serialises this into the workspace snapshot so a registered kind becomes a
   * first-class palette block instead of the generic fallback. Omitted ⇒ the SPA renders
   * the kind with its generic fallback metadata.
   */
  presentation?: AgentPresentation
}

/**
 * Derive `agent.output` from a `structuredOutput` schema when the author didn't set it by
 * hand — so a structured kind declares ONE valibot schema and the engine spec falls out of
 * it. An explicit `agent.output` always wins (the author overrode the derivation).
 */
function withDerivedOutput(definition: AgentKindDefinition): AgentKindDefinition {
  const { structuredOutput, agent } = definition
  if (!structuredOutput || !agent || agent.output) return definition
  return { ...definition, agent: { ...agent, output: structuredOutput.spec } }
}

/**
 * App-owned registry of agent kinds, mirroring the backend-registries pilot
 * (`RunnerBackendRegistry` / `EnvironmentBackendRegistry`). The composition root news ONE
 * instance per app (`defaultAgentKindRegistry()`), threads it through `CoreDependencies`, and
 * every prompt build / routing decision reads it from there — so there is no module-global
 * `Map`, no `clear*()` test cruft, and no external-adapter module-identity gotcha: a
 * deployment registers extra kinds by reference (`registry.register(def)`) on the instance the
 * facade injects. The built-in kinds (`bug-investigator` / `repro-test` / `environment-analyst`
 * / `code-commenter` / `blueprints` / `spec-writer` / the document + initiative kinds) are
 * pre-loaded by the factory, not by an import side effect.
 */
export class AgentKindRegistry {
  private readonly registry = new Map<string, AgentKindDefinition>()
  // Custom trait DEFINITIONS (id → guidance), pre-loaded with the standard trait set below.
  // The former module-global `traitRegistry` — now owned by this instance (traits are
  // capabilities OF agent kinds, so they live with the kind registry rather than a parallel
  // module `Map`, which keeps the whole trait vocabulary on one injectable seam).
  private readonly traitDefinitions = new Map<AgentTrait, AgentTraitDefinition>()
  // Extra trait ASSIGNMENTS to EXISTING kinds (the former module-global `assignedTraits`) —
  // e.g. `@cat-factory/consensus` marking built-in kinds eligible for a consensus strategy.
  // Distinct from a kind's STANDARD_AGENT_TRAITS and a registered kind's own `traits`: this
  // seam adds traits to a kind WITHOUT redefining its prompt. Unioned in `traitsFor`.
  private readonly assignedTraits = new Map<AgentKind, Set<AgentTrait>>()
  // CAPABILITY definitions shared across kinds: bundled skills (id → the SKILL.md payload the
  // deployment ships in code) and tool servers (id → the MCP server definition). They live here
  // for the same reason traits do — a skill and a tool server are capabilities OF agent kinds,
  // so the whole vocabulary stays on one injectable seam rather than two parallel module `Map`s.
  private readonly bundledSkills = new Map<string, BundledSkillDefinition>()
  private readonly toolServerDefinitions = new Map<string, McpServerDefinition>()
  // Capability ASSIGNMENTS to EXISTING kinds — the skills/tool-servers analogue of
  // `assignedTraits`. This is how a deployment gives a BUILT-IN kind (`coder`, `pr-reviewer`)
  // its house playbook or its issue-tracker MCP server without redefining the kind's prompt.
  private readonly assignedSkills = new Map<AgentKind, AgentKindSkillRef[]>()
  private readonly assignedToolServers = new Map<AgentKind, AgentKindToolRef[]>()
  // VARIANTS of existing kinds (id → definition) — an alternate prompt a step selects through
  // `stepOptions.agentVariantId`. They live here beside the kinds and their capabilities for the
  // same reason those do, but they are deliberately NOT kinds: a variant never appears in
  // `all()`, never answers `get()`, and never changes a behavioural answer. See ./variants.
  private readonly variantDefinitions = new Map<string, AgentKindVariantDefinition>()
  // COMPANION pairings (companion kind → what it reviews), pre-loaded with the built-in catalog
  // below. Here rather than in a module `Map` for the reason traits and capabilities are: a
  // companion is a relationship BETWEEN agent kinds, so the whole vocabulary stays on one
  // injectable seam a deployment can extend and a test can build fresh.
  //
  // This is also what a custom REWORK PAIR needs. Before it, a deployment wanting "my producer,
  // reviewed and looped back below a bar" had to reach for a judge, which is a different machine:
  // a judge scores against a rubric and disposes, where a companion loops its PRODUCER back for
  // automatic rework on the budget the engine already tracks. Registering the pair is now the
  // supported way to say that.
  private readonly companions = new Map<AgentKind, CompanionDefinition>()

  constructor() {
    for (const definition of STANDARD_TRAIT_DEFINITIONS) {
      this.traitDefinitions.set(definition.id, definition)
    }
    for (const companion of COMPANIONS) this.companions.set(companion.kind, companion)
  }

  /** Register a custom agent kind. A later registration of the same id replaces the earlier one. */
  register(definition: AgentKindDefinition): void {
    this.registry.set(definition.kind, withDerivedOutput(definition))
  }

  /** Register several custom agent kinds at once. */
  registerAll(definitions: Iterable<AgentKindDefinition>): void {
    for (const definition of definitions) this.register(definition)
  }

  /** The registered definition for a kind, or undefined for built-in / unregistered kinds. */
  get(kind: AgentKind): AgentKindDefinition | undefined {
    return this.registry.get(kind)
  }

  /** All registered agent kinds (registration order). */
  all(): AgentKindDefinition[] {
    return [...this.registry.values()]
  }

  /**
   * Whether a registered kind runs in a container — either it set `requiresContainer`
   * explicitly, or its `agent` step declares a container surface. False for built-in /
   * unregistered kinds.
   */
  requiresContainer(kind: AgentKind): boolean {
    const definition = this.registry.get(kind)
    if (!definition) return false
    if (definition.requiresContainer === true) return true
    const surface = definition.agent?.surface
    return surface === 'container-explore' || surface === 'container-coding'
  }

  /**
   * Whether a registered kind fans out across the block's connected involved-service repos
   * (see {@link AgentKindDefinition.fanOutMultiRepo}). False for built-in / unregistered kinds —
   * the executor keeps a small allow-list for the pre-registry built-ins (`coder` / `ci-fixer`).
   */
  fansOutMultiRepo(kind: AgentKind): boolean {
    return this.registry.get(kind)?.fanOutMultiRepo === true
  }

  /** A registered kind's system prompt, or undefined when the kind is not registered. */
  systemPrompt(kind: AgentKind): string | undefined {
    const definition = this.registry.get(kind)
    if (!definition) return undefined
    return typeof definition.systemPrompt === 'function'
      ? definition.systemPrompt(kind)
      : definition.systemPrompt
  }

  /** A registered kind's user prompt, or undefined when the kind is not registered / has no builder. */
  userPrompt(context: AgentRunContext, dispatch?: AgentDispatchContext): string | undefined {
    return this.registry.get(context.agentKind)?.userPrompt?.(context, dispatch)
  }

  /**
   * A registered kind's ADDITIVE task instructions, appended to the generic block-context
   * prompt, or undefined when the kind is not registered / declared none. See
   * {@link AgentKindDefinition.userPromptSuffix}.
   */
  userPromptSuffix(context: AgentRunContext, dispatch?: AgentDispatchContext): string | undefined {
    return this.registry.get(context.agentKind)?.userPromptSuffix?.(context, dispatch)
  }

  /**
   * A registered kind's structured-result mapping, or undefined when it declared none (the
   * caller then surfaces the raw JSON on `custom`). See
   * {@link AgentKindDefinition.mapStructuredResult}.
   */
  mapStructuredResult(kind: AgentKind): AgentKindDefinition['mapStructuredResult'] {
    return this.registry.get(kind)?.mapStructuredResult
  }

  /** A registered kind's web-research hint, or undefined when unregistered / not supplied. */
  webResearchHint(kind: AgentKind): string | undefined {
    return this.registry.get(kind)?.webResearchHint
  }

  /** A registered kind's execution tuning, or undefined when unregistered / not supplied. */
  tuning(kind: AgentKind): AgentTuning | undefined {
    return this.registry.get(kind)?.tuning
  }

  /**
   * Whether a registered kind may be ESTIMATE-GATED, or undefined when unregistered / not
   * supplied. Deliberately tri-state rather than defaulted to `false` here: `isGatableKind`
   * falls back to the BUILT-IN set when this is undefined, and a `false` default would shadow
   * every built-in's answer. See {@link AgentKindDefinition.gatable}.
   */
  gatable(kind: AgentKind): boolean | undefined {
    return this.registry.get(kind)?.gatable
  }

  /**
   * Whether this kind's resolved best-practice standards are folded into its system prompt
   * (the default) or delivered as `.cat-context/` files by its own preOp. See
   * {@link AgentKindDefinition.standardsDelivery}.
   */
  standardsDelivery(kind: AgentKind): 'prompt' | 'context-files' | 'none' {
    return this.registry.get(kind)?.standardsDelivery ?? 'prompt'
  }

  /** A registered kind's contributed config descriptors, or an empty array when none. */
  configContributions(kind: AgentKind): AgentConfigDescriptor[] {
    return this.registry.get(kind)?.configContributions ?? []
  }

  /** A registered kind's agent-step spec (surface/output/clone), or undefined when none. */
  agentStep(kind: AgentKind): AgentStepSpec | undefined {
    return this.registry.get(kind)?.agent
  }

  /** A registered kind's pre-op hooks (run before the agent step), or an empty array. */
  preOps(kind: AgentKind): RepoOp[] {
    return this.registry.get(kind)?.preOps ?? []
  }

  /** A registered kind's post-op hooks (run after the agent step), or an empty array. */
  postOps(kind: AgentKind): RepoOp[] {
    return this.registry.get(kind)?.postOps ?? []
  }

  /** A registered kind's frontend presentation metadata, or undefined when not supplied. */
  presentation(kind: AgentKind): AgentPresentation | undefined {
    return this.registry.get(kind)?.presentation
  }

  /**
   * A registered kind's schema-driven structured output (its typed `parse`/`safeParse` + the
   * derived spec), or undefined when the kind isn't registered / declared no schema. A post-op
   * or step-resolver uses this to parse `result.custom` without hand-writing a coercer.
   */
  structuredOutput(kind: AgentKind): StructuredOutput<unknown> | undefined {
    return this.registry.get(kind)?.structuredOutput
  }

  /**
   * Register a custom trait definition (id + optional prompt guidance). A later registration of
   * the same id replaces the earlier one. Standard traits are pre-loaded in the constructor.
   * Read back via {@link traitDefinition} — the `traitGuidanceFor` helper uses it.
   */
  registerTrait(definition: AgentTraitDefinition): void {
    this.traitDefinitions.set(definition.id, definition)
  }

  /** Register several custom trait definitions at once. */
  registerTraits(definitions: Iterable<AgentTraitDefinition>): void {
    for (const definition of definitions) this.registerTrait(definition)
  }

  /** The definition for a trait id, or undefined when it is a pure marker / unregistered. */
  traitDefinition(id: AgentTrait): AgentTraitDefinition | undefined {
    return this.traitDefinitions.get(id)
  }

  /**
   * Assign extra capability traits to an (existing) agent kind — additive, idempotent per trait.
   * Used by an opt-in package (e.g. `@cat-factory/consensus`) to mark built-in kinds eligible for
   * a strategy without redefining their prompt. Read back via {@link assignedTraitsFor}.
   *
   * There is deliberately NO inverse. A trait a kind declares is part of what that kind IS, and a
   * deployment removing one is claiming to know better than the kind's author about the kind's own
   * requirements. The ask that reaches for a subtraction is always a trait that is wrong for a
   * particular USE, and the fix is a correct trait rather than a way to drop a stated one: the
   * `binary-storage` precondition is the worked example, and what it needed was to be resolved
   * from the step's own storage selection (`storesThroughPlatformAssets`), not a way to unassign
   * it. A subtraction would also be half a seam by construction, since `traitsFor` unions three
   * sources and a kind's traits can come from `STANDARD_AGENT_TRAITS`, where nothing a deployment
   * writes can reach them: it would remove a trait from some kinds and silently not from others.
   */
  assignTraits(kind: AgentKind, traits: Iterable<AgentTrait>): void {
    const set = this.assignedTraits.get(kind) ?? new Set<AgentTrait>()
    for (const trait of traits) set.add(trait)
    this.assignedTraits.set(kind, set)
  }

  /** The extra traits assigned to a kind (empty when none). Unioned into `traitsFor`. */
  assignedTraitsFor(kind: AgentKind): ReadonlySet<AgentTrait> {
    return this.assignedTraits.get(kind) ?? EMPTY_TRAIT_SET
  }

  /**
   * Register a bundled skill — a `SKILL.md` payload the deployment ships in code — so any number
   * of kinds can reference it by id. A later registration of the same id replaces the earlier one.
   */
  registerSkill(definition: BundledSkillDefinition): void {
    this.bundledSkills.set(definition.id, definition)
  }

  /** Register several bundled skills at once. */
  registerSkills(definitions: Iterable<BundledSkillDefinition>): void {
    for (const definition of definitions) this.registerSkill(definition)
  }

  /** A registered bundled skill, or undefined when the id is unknown. */
  bundledSkill(id: string): BundledSkillDefinition | undefined {
    return this.bundledSkills.get(id)
  }

  /**
   * Register a tool server (MCP) so any number of kinds can reference it by id. A later
   * registration of the same id replaces the earlier one — which is also how a deployment
   * REPOINTS a server an installed package registered (e.g. at its own internal endpoint)
   * without forking the package.
   */
  registerToolServer(definition: McpServerDefinition): void {
    this.toolServerDefinitions.set(definition.id, definition)
  }

  /** Register several tool servers at once. */
  registerToolServers(definitions: Iterable<McpServerDefinition>): void {
    for (const definition of definitions) this.registerToolServer(definition)
  }

  /** A registered tool server, or undefined when the id is unknown. */
  toolServerDefinition(id: string): McpServerDefinition | undefined {
    return this.toolServerDefinitions.get(id)
  }

  /**
   * Every tool server registered BY ID, whether or not a kind references it.
   *
   * The complement of walking {@link kindsWithCapabilities}, and the only way to see a registration
   * attached to NOTHING. That state is invisible to every other check: boot validation reaches a
   * definition through the kind that declares it, so an orphan registration passes every rule while
   * its credentials sit in the operator's checklist as keys no dispatch will ever ask for. The
   * operability surface reports it with an empty `declaredBy` rather than filtering it out.
   *
   * Inline definitions are deliberately absent — those belong to one kind by construction and are
   * reachable only through it. Registration order, which is stable but not meaningful.
   */
  allToolServers(): McpServerDefinition[] {
    return [...this.toolServerDefinitions.values()]
  }

  /**
   * Give an EXISTING kind extra skills — additive, so a deployment attaches its house playbook to
   * a built-in kind (`coder`, `pr-reviewer`) without redefining it. Deduplicated with the kind's
   * own declarations at resolution time.
   */
  assignSkills(kind: AgentKind, refs: Iterable<AgentKindSkillRef>): void {
    this.assignedSkills.set(kind, [...(this.assignedSkills.get(kind) ?? []), ...refs])
  }

  /** Give an EXISTING kind extra tool servers — the {@link assignSkills} analogue. */
  assignToolServers(kind: AgentKind, refs: Iterable<AgentKindToolRef>): void {
    this.assignedToolServers.set(kind, [...(this.assignedToolServers.get(kind) ?? []), ...refs])
  }

  /**
   * Register a COMPANION: a kind that reviews the output of the step immediately before it,
   * rates it, and below the step's threshold loops that producer back for automatic rework
   * before any human is asked.
   *
   * The companion kind and its `targets` are ordinary agent kinds, registered through
   * {@link register} like any other; this only records the PAIRING. A later registration of the
   * same companion kind replaces the earlier one, matching every other seam here.
   *
   * Two things a registration must respect, both enforced elsewhere rather than here because
   * they are properties of a PIPELINE, not of the pair: a companion step must sit immediately
   * after a step whose kind is in its `targets` (`assertValidCompanionPlacement`), and a
   * `container-explore` companion needs the producer to have pushed a branch to read.
   */
  registerCompanion(definition: CompanionDefinition): void {
    this.companions.set(definition.kind, definition)
  }

  /** Register several companions at once. */
  registerCompanions(definitions: Iterable<CompanionDefinition>): void {
    for (const definition of definitions) this.registerCompanion(definition)
  }

  /** The companion definition for `kind`, or undefined if it is not a companion. */
  companionFor(kind: AgentKind): CompanionDefinition | undefined {
    return this.companions.get(kind)
  }

  /** Whether `kind` is a companion (driven by the engine's companion review loop). */
  isCompanionKind(kind: AgentKind): boolean {
    return this.companions.has(kind)
  }

  /** The producer kinds a companion may be attached to (empty if `kind` is not a companion). */
  companionTargets(kind: AgentKind): AgentKind[] {
    return this.companions.get(kind)?.targets ?? []
  }

  /**
   * Whether `kind` reviews in a CONTAINER (cloning the producer's PR branch and reading the real
   * repository) rather than inline. The single answer the executor uses to route the companion
   * through the container path, the engine uses to keep it off the inline companion path, and the
   * prompt uses to tell it to read the checkout. False for non-companions and inline companions.
   */
  isContainerBackedCompanion(kind: AgentKind): boolean {
    return this.companions.get(kind)?.surface === 'container-explore'
  }

  /** Every registered companion (built-ins first, then registration order). */
  allCompanions(): CompanionDefinition[] {
    return [...this.companions.values()]
  }

  /**
   * Every skill declared for a kind — its own `skills` plus any assigned to it — normalised into
   * the bundled/catalog split the engine resolves, with unknown registered ids reported rather
   * than thrown on (boot validation turns those into a startup error; a dispatch drops them).
   * A kind's OWN declarations come first, so it controls the order its playbooks are applied in.
   */
  skillsFor(kind: AgentKind): ReturnType<typeof normalizeSkillRefs> {
    const own = this.registry.get(kind)?.skills ?? []
    const assigned = this.assignedSkills.get(kind) ?? []
    if (own.length === 0 && assigned.length === 0) return EMPTY_SKILL_REFS
    return normalizeSkillRefs([...own, ...assigned], (id) => this.bundledSkills.get(id))
  }

  /**
   * Every tool server declared for a kind — its own `toolServers` plus any assigned to it —
   * resolved to definitions and deduplicated by server id. Unknown registered ids are reported,
   * not thrown on (see {@link skillsFor}).
   */
  toolServersFor(kind: AgentKind): ReturnType<typeof normalizeToolRefs> {
    const own = this.registry.get(kind)?.toolServers ?? []
    const assigned = this.assignedToolServers.get(kind) ?? []
    if (own.length === 0 && assigned.length === 0) return EMPTY_TOOL_REFS
    return normalizeToolRefs([...own, ...assigned], (id) => this.toolServerDefinitions.get(id))
  }

  /**
   * Every kind that has a skill or tool server declared FOR it, whether on its own registration or
   * through {@link assignSkills} / {@link assignToolServers}.
   *
   * THE enumeration for "kinds with capabilities", and the reason it exists is that `all()` is not
   * one. Assignment is the RECOMMENDED path: it is how a deployment attaches a playbook or an MCP
   * server to `coder`, `ci-fixer`, `tester-api`, `merger` or `conflict-resolver`, none of which are
   * registry entries, so an enumeration that walked `all()` skipped exactly the commonest case.
   * Boot validation and the capability-credential checklist both did, which meant a server declared
   * by assignment reached neither the `insecure_tool_server_url` refusal nor the operator's list of
   * keys to fill in.
   *
   * A registered kind that declares NEITHER is left out, so the answer means what its name says and
   * a caller may read a non-empty list off it. That matters for the reader more than for today's two
   * consumers, whose per-kind checks no-op on an empty declaration either way. The test is the RAW
   * declaration, not a resolved one: a kind naming an id nothing registered still belongs here, since
   * naming the unregistered id is precisely what boot validation has to report.
   *
   * Anything new that enumerates kinds to read their skills or tool servers uses THIS, not `all()`,
   * or that hole reopens. Stable but arbitrary order: registered kinds in registration order, then
   * skill-assigned kinds, then tool-server-assigned ones. Nothing may depend on it; a kind's OWN
   * capability precedence is `skillsFor` / `toolServersFor`, which is a different question.
   */
  kindsWithCapabilities(): AgentKind[] {
    const kinds = new Set<AgentKind>()
    for (const [kind, definition] of this.registry) {
      if (definition.skills?.length || definition.toolServers?.length) kinds.add(kind)
    }
    for (const [kind, refs] of this.assignedSkills) if (refs.length) kinds.add(kind)
    for (const [kind, refs] of this.assignedToolServers) if (refs.length) kinds.add(kind)
    return [...kinds]
  }

  /**
   * Register a VARIATION of an existing agent kind — an alternate prompt a pipeline step selects
   * by id, running the base kind in every other respect. A later registration of the same id
   * replaces the earlier one, which is also how a deployment RE-WORDS a variant an installed
   * package shipped without forking it — safe for Kaizen because a step is keyed by a fingerprint
   * of the text its variant contributed, not by the id alone (see `AppliedAgentVariant`).
   *
   * Nothing is validated here (an id may legitimately be registered before its base kind is):
   * `validateRegistrations` reports an unknown base, a collision with a kind id, and a variant
   * that changes no text, as startup errors.
   */
  registerVariant(definition: AgentKindVariantDefinition): void {
    this.variantDefinitions.set(definition.id, definition)
  }

  /** Register several variants at once. */
  registerVariants(definitions: Iterable<AgentKindVariantDefinition>): void {
    for (const definition of definitions) this.registerVariant(definition)
  }

  /** A registered variant, or undefined when the id is unknown. */
  variant(id: string): AgentKindVariantDefinition | undefined {
    return this.variantDefinitions.get(id)
  }

  /** All registered variants (registration order). */
  variants(): AgentKindVariantDefinition[] {
    return [...this.variantDefinitions.values()]
  }

  /**
   * The variants registered for one kind — what the pipeline builder offers on a step of that
   * kind. Empty when the kind has none, which is every kind on the stock product.
   */
  variantsForKind(kind: AgentKind): AgentKindVariantDefinition[] {
    return this.variants().filter((variant) => variant.baseKind === kind)
  }
}

/** Shared empty set so `assignedTraitsFor` allocates nothing on the common no-assignment path. */
const EMPTY_TRAIT_SET: ReadonlySet<AgentTrait> = new Set<AgentTrait>()

// Shared empty results so the no-capability path (every built-in kind, on every dispatch)
// allocates nothing. Frozen because they are handed to callers.
const EMPTY_SKILL_REFS = Object.freeze({
  bundled: Object.freeze([]) as never[],
  catalog: Object.freeze([]) as never[],
  unknown: Object.freeze([]) as never[],
})
const EMPTY_TOOL_REFS = Object.freeze({
  servers: Object.freeze([]) as never[],
  unknown: Object.freeze([]) as never[],
})

/**
 * A fresh registry pre-loaded with the built-in agent kinds. This is the single place the
 * built-ins are installed — there is no module-load side effect — so every app (and every
 * test) gets its own instance with the built-ins present. A deployment then registers its
 * own kinds by reference on the instance the composition root injects.
 */
export function defaultAgentKindRegistry(): AgentKindRegistry {
  const registry = new AgentKindRegistry()
  registerBugInvestigatorAgent(registry)
  registerForkProposerAgent(registry)
  registerPrReviewerAgent(registry)
  registerChallengeInvestigatorAgent(registry)
  registerReproTestAgent(registry)
  registerDeployFixerAgent(registry)
  registerRalphAgent(registry)
  registerDocumentAgents(registry)
  registerCodeCommenterAgent(registry)
  registerInitiativeAgents(registry)
  registerSpecBlueprintAgents(registry)
  registerEnvironmentAnalystAgent(registry)
  registerSpikeAgent(registry)
  registerSkillAgent(registry)
  registerMediaAgent(registry)
  // The built-in CONTAINER kinds (implementer, testers, fixers, assessors, read-only explorers).
  // Disjoint from every id above — registration replaces by kind, so an overlap would silently
  // drop whichever definition ran first.
  registerBuiltInContainerAgents(registry)
  return registry
}
