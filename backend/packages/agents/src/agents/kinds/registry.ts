import type {
  AgentConfigDescriptor,
  AgentKind,
  AgentRunContext,
  AgentStepSpec,
  RepoOp,
} from '@cat-factory/kernel'
import type { AgentPresentation } from '@cat-factory/contracts'
import type { AgentTrait } from './traits.js'

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
   * The optional LLM step's execution surface + output/clone spec (inline, or a
   * container explore/coding run). Present ⇒ the kind runs an agent step; omitted ⇒ the
   * kind is pure pre/post-op work (no LLM). A container surface implies the kind needs a
   * checkout — see {@link registeredKindRequiresContainer}, which now also derives the
   * container requirement from this — so `requiresContainer` need not be set alongside it.
   */
  agent?: AgentStepSpec
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

// Process-wide registry, mirroring the Worker's model-provider registry. Registration
// is a startup side effect read by every prompt build / routing decision, so the extra
// kinds reach all paths — HTTP requests, the durable driver and the cron sweeper.
const registry = new Map<string, AgentKindDefinition>()

/** Register a custom agent kind. A later registration of the same id replaces the earlier one. */
export function registerAgentKind(definition: AgentKindDefinition): void {
  registry.set(definition.kind, definition)
}

/** Register several custom agent kinds at once. */
export function registerAgentKinds(definitions: Iterable<AgentKindDefinition>): void {
  for (const definition of definitions) registerAgentKind(definition)
}

/** The registered definition for a kind, or undefined for built-in / unregistered kinds. */
export function registeredAgentKind(kind: AgentKind): AgentKindDefinition | undefined {
  return registry.get(kind)
}

/** All registered custom agent kinds (registration order). */
export function registeredAgentKinds(): AgentKindDefinition[] {
  return [...registry.values()]
}

/**
 * Whether a registered kind runs in a container — either it set `requiresContainer`
 * explicitly, or its `agent` step declares a container surface. False for built-in /
 * unregistered kinds.
 */
export function registeredKindRequiresContainer(kind: AgentKind): boolean {
  const definition = registry.get(kind)
  if (!definition) return false
  if (definition.requiresContainer === true) return true
  const surface = definition.agent?.surface
  return surface === 'container-explore' || surface === 'container-coding'
}

/** Drop all registered kinds. Intended for tests that exercise registration. */
export function clearRegisteredAgentKinds(): void {
  registry.clear()
}

/** A registered kind's system prompt, or undefined when the kind is not registered. */
export function registeredSystemPrompt(kind: AgentKind): string | undefined {
  const definition = registry.get(kind)
  if (!definition) return undefined
  return typeof definition.systemPrompt === 'function'
    ? definition.systemPrompt(kind)
    : definition.systemPrompt
}

/** A registered kind's user prompt, or undefined when the kind is not registered / has no builder. */
export function registeredUserPrompt(context: AgentRunContext): string | undefined {
  return registry.get(context.agentKind)?.userPrompt?.(context)
}

/** A registered kind's web-research hint, or undefined when unregistered / not supplied. */
export function registeredWebResearchHint(kind: AgentKind): string | undefined {
  return registry.get(kind)?.webResearchHint
}

/** A registered kind's contributed config descriptors, or an empty array when none. */
export function registeredConfigContributions(kind: AgentKind): AgentConfigDescriptor[] {
  return registry.get(kind)?.configContributions ?? []
}

/** A registered kind's agent-step spec (surface/output/clone), or undefined when none. */
export function registeredAgentStep(kind: AgentKind): AgentStepSpec | undefined {
  return registry.get(kind)?.agent
}

/** A registered kind's pre-op hooks (run before the agent step), or an empty array. */
export function registeredPreOps(kind: AgentKind): RepoOp[] {
  return registry.get(kind)?.preOps ?? []
}

/** A registered kind's post-op hooks (run after the agent step), or an empty array. */
export function registeredPostOps(kind: AgentKind): RepoOp[] {
  return registry.get(kind)?.postOps ?? []
}

/** A registered kind's frontend presentation metadata, or undefined when not supplied. */
export function registeredAgentPresentation(kind: AgentKind): AgentPresentation | undefined {
  return registry.get(kind)?.presentation
}
