import type {
  AgentConfigDescriptor,
  AgentKind,
  AgentRunContext,
  AgentStepSpec,
  RepoOp,
} from '@cat-factory/kernel'
import type { AgentPresentation } from '@cat-factory/contracts'
import type { AgentTrait } from './traits.js'
import type { AgentTuning } from './tuning.js'
import type { StructuredOutput } from './structured-output.js'
import { registerBugInvestigatorAgent } from './bug-investigator.js'
import { registerForkProposerAgent } from './fork-proposer.js'
import { registerReproTestAgent } from './repro-test.js'
import { registerDocumentAgents } from './document.js'
import { registerCodeCommenterAgent } from './code-commenter.js'
import { registerInitiativeAgents } from './initiative.js'
import { registerEnvironmentAnalystAgent } from './environment-analyst.js'
import { registerSpikeAgent } from './spike.js'

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
   */
  systemPrompt: string | ((kind: AgentKind) => string)
  /**
   * Optional custom user-prompt builder. When omitted the kind uses the generic user
   * prompt (block context + prior pipeline outputs), exactly like any other
   * non-standard-phase kind. Human revision feedback is appended automatically.
   */
  userPrompt?: (context: AgentRunContext) => string
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
   * their own traits registered via `registerAgentTrait`. Omitted ⇒ no traits.
   */
  traits?: AgentTrait[]
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
 * / `code-commenter` / the document + initiative kinds) are pre-loaded by the factory, not by an
 * import side effect.
 */
export class AgentKindRegistry {
  private readonly registry = new Map<string, AgentKindDefinition>()

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
  userPrompt(context: AgentRunContext): string | undefined {
    return this.registry.get(context.agentKind)?.userPrompt?.(context)
  }

  /** A registered kind's web-research hint, or undefined when unregistered / not supplied. */
  webResearchHint(kind: AgentKind): string | undefined {
    return this.registry.get(kind)?.webResearchHint
  }

  /** A registered kind's execution tuning, or undefined when unregistered / not supplied. */
  tuning(kind: AgentKind): AgentTuning | undefined {
    return this.registry.get(kind)?.tuning
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
}

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
  registerReproTestAgent(registry)
  registerDocumentAgents(registry)
  registerCodeCommenterAgent(registry)
  registerInitiativeAgents(registry)
  registerEnvironmentAnalystAgent(registry)
  registerSpikeAgent(registry)
  return registry
}
