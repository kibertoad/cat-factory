import { SPEC_FEATURES_DIR, SPEC_MODULES_DIR, SPEC_OVERVIEW_PATH } from '@cat-factory/contracts'
import type { AgentKind } from '@cat-factory/kernel'
import { registeredAgentKind } from './registry.js'

// Agent traits: first-class, checkable CAPABILITIES an agent kind carries, beyond its
// role prompt. A trait both marks a kind for engine behaviour (e.g. `code-aware` tells
// the execution engine to fold the running service's selected best-practice fragments
// into the agent's system prompt) and can contribute fixed GUIDANCE appended to the
// kind's system prompt (e.g. `spec-aware` explains the in-repo `spec/` artifact).
//
// Built-in kinds get their traits from STANDARD_AGENT_TRAITS below; custom kinds declare
// theirs via `registerAgentKind({ traits })`. Custom traits (with their own guidance) are
// registered with `registerAgentTrait`, mirroring the custom-agent / model-provider seams.

/** A trait id. Free-form so deployments can define their own beyond the standard two. */
export type AgentTrait = string

/**
 * Code-aware kinds read and/or change the service's code. The service's selected
 * best-practice / guideline fragments (Node, Fastify, performance, …) are folded into
 * their system prompt by the execution engine.
 */
export const CODE_AWARE_TRAIT: AgentTrait = 'code-aware'

/**
 * Spec-aware kinds are told to read the in-repo `spec/` artifact (the prescriptive
 * service specification) and how to interpret it. The instruction is appended to their
 * system prompt via {@link traitGuidanceFor}.
 */
export const SPEC_AWARE_TRAIT: AgentTrait = 'spec-aware'

/**
 * Binary-storage-aware kinds need the account's binary-artifact store (R2 / S3 / fs /
 * Postgres) configured to do their job — e.g. the UI Tester uploads its screenshots there.
 * A pure MARKER trait (no prompt guidance): the execution engine refuses to START a
 * pipeline carrying such a kind when the workspace's account has no storage configured,
 * with an actionable `binary_storage_unconfigured` conflict pointing the human at the
 * content-storage settings. This makes the precondition universal — a future screenshot/
 * artifact-producing kind just carries the trait instead of the engine hard-coding it.
 */
export const BINARY_STORAGE_TRAIT: AgentTrait = 'binary-storage'

/** The guidance appended to a spec-aware kind's system prompt — explains the spec format. */
export const SPEC_AWARE_GUIDANCE = [
  `This repository may contain a prescriptive SPECIFICATION for the service under the \`spec/\` directory — the source of truth for what the service must do. It is sharded by a module (domain) → feature (group) taxonomy. When it is present, read it before doing the work:`,
  `- \`${SPEC_OVERVIEW_PATH}\` first, for the high-level product intent and an index of the modules and their features (with links).`,
  `- \`${SPEC_MODULES_DIR}/<module>/<feature>.md\` for the feature you are working on — its requirements and the domain rules scoped to it.`,
  `- \`${SPEC_MODULES_DIR}/<module>/<feature>.json\` is the canonical machine-readable shard the markdown is rendered from; consult it when you need exact detail.`,
  `- \`${SPEC_FEATURES_DIR}/<module>/<feature>.feature\` for the Gherkin (Given/When/Then) acceptance scenarios.`,
  `Read only the modules/features relevant to your task rather than the whole tree. Treat the spec as authoritative for required behaviour: make your change satisfy it, and if your change conflicts with the spec, follow the spec or call out the discrepancy rather than silently diverging.`,
].join('\n')

/**
 * Built-in trait assignment per agent kind.
 *  - `code-aware`: the kinds that read/modify the service's code, so the service's
 *    best-practice fragments are relevant to them.
 *  - `spec-aware`: every code-touching kind (anything that clones and reads the repo),
 *    so each is pointed at the in-repo spec. The `spec-writer` is intentionally absent —
 *    it AUTHORS the spec rather than consuming it.
 */
export const STANDARD_AGENT_TRAITS: Partial<Record<AgentKind, AgentTrait[]>> = {
  architect: [CODE_AWARE_TRAIT, SPEC_AWARE_TRAIT],
  coder: [CODE_AWARE_TRAIT, SPEC_AWARE_TRAIT],
  reviewer: [CODE_AWARE_TRAIT, SPEC_AWARE_TRAIT],
  'ci-fixer': [CODE_AWARE_TRAIT, SPEC_AWARE_TRAIT],
  fixer: [CODE_AWARE_TRAIT, SPEC_AWARE_TRAIT],
  'conflict-resolver': [SPEC_AWARE_TRAIT],
  'tester-api': [SPEC_AWARE_TRAIT],
  // The UI Tester captures screenshots and uploads them to the binary-artifact store
  // (the visual-confirmation gate reads them back), so it needs storage configured.
  'tester-ui': [SPEC_AWARE_TRAIT, BINARY_STORAGE_TRAIT],
  playwright: [SPEC_AWARE_TRAIT],
  blueprints: [SPEC_AWARE_TRAIT],
  'business-documenter': [SPEC_AWARE_TRAIT],
  'business-reviewer': [SPEC_AWARE_TRAIT],
  analysis: [SPEC_AWARE_TRAIT],
  mocker: [SPEC_AWARE_TRAIT],
  merger: [SPEC_AWARE_TRAIT],
  // The on-call agent clones the released change and reads the code to correlate the diff
  // with the regression evidence, so it gets the service's best-practice + spec context.
  'on-call': [CODE_AWARE_TRAIT, SPEC_AWARE_TRAIT],
}

/** Definition of a (custom) trait: its id and optional system-prompt guidance. */
export interface AgentTraitDefinition {
  /** The trait id used in `STANDARD_AGENT_TRAITS` / `AgentKindDefinition.traits`. */
  id: AgentTrait
  /**
   * Guidance folded into the system prompt of every kind carrying this trait. A function
   * form receives the kind id. Omit for a pure marker trait whose effect lives in the
   * engine (like `code-aware`).
   */
  guidance?: string | ((kind: AgentKind) => string)
}

// Process-wide trait registry, mirroring the agent-kind / model-provider registries.
const traitRegistry = new Map<AgentTrait, AgentTraitDefinition>()

// Extra trait ASSIGNMENTS registered by a deployment/plugin at startup — e.g. the
// optional `@cat-factory/consensus` package marking which built-in kinds are eligible
// for a consensus strategy (`specialist-panel-capable`, …). Distinct from a kind's
// built-in STANDARD_AGENT_TRAITS and from a registered custom kind's own `traits`:
// this seam adds traits to an EXISTING kind without redefining its prompt. Unioned in
// {@link traitsFor}. Mirrors the registry seams above.
const assignedTraits = new Map<AgentKind, Set<AgentTrait>>()

/** Assign extra capability traits to an (existing) agent kind. Additive; idempotent per trait. */
export function assignAgentTraits(kind: AgentKind, traits: Iterable<AgentTrait>): void {
  const set = assignedTraits.get(kind) ?? new Set<AgentTrait>()
  for (const trait of traits) set.add(trait)
  assignedTraits.set(kind, set)
}

/** Drop all extra trait assignments. Intended for tests that exercise assignment. */
export function clearAssignedAgentTraits(): void {
  assignedTraits.clear()
}

/** Register a custom trait definition. A later registration of the same id replaces it. */
export function registerAgentTrait(definition: AgentTraitDefinition): void {
  traitRegistry.set(definition.id, definition)
}

/** Register several custom trait definitions at once. */
export function registerAgentTraits(definitions: Iterable<AgentTraitDefinition>): void {
  for (const definition of definitions) registerAgentTrait(definition)
}

/** The definition for a trait id, or undefined when it is a pure marker / unregistered. */
export function registeredAgentTrait(id: AgentTrait): AgentTraitDefinition | undefined {
  return traitRegistry.get(id)
}

/** Drop all registered (custom) traits. Intended for tests; standard traits re-register below. */
export function clearRegisteredAgentTraits(): void {
  traitRegistry.clear()
  registerStandardTraits()
}

/** The traits a kind carries: its built-in set unioned with a registered custom kind's. */
export function traitsFor(kind: AgentKind): Set<AgentTrait> {
  const traits = new Set<AgentTrait>(STANDARD_AGENT_TRAITS[kind] ?? [])
  for (const trait of registeredAgentKind(kind)?.traits ?? []) traits.add(trait)
  for (const trait of assignedTraits.get(kind) ?? []) traits.add(trait)
  return traits
}

/** Whether `kind` carries `trait`. */
export function hasTrait(kind: AgentKind, trait: AgentTrait): boolean {
  return traitsFor(kind).has(trait)
}

/**
 * The guidance lines contributed by the traits a kind carries, in trait order. Folded
 * into the kind's system prompt by `systemPromptFor`. Marker traits (no guidance, e.g.
 * `code-aware`) contribute nothing here.
 */
export function traitGuidanceFor(kind: AgentKind): string[] {
  const lines: string[] = []
  for (const trait of traitsFor(kind)) {
    const guidance = traitRegistry.get(trait)?.guidance
    if (!guidance) continue
    lines.push(typeof guidance === 'function' ? guidance(kind) : guidance)
  }
  return lines
}

/** Register the two standard traits' definitions (spec-aware carries guidance). */
function registerStandardTraits(): void {
  registerAgentTrait({ id: CODE_AWARE_TRAIT })
  registerAgentTrait({ id: SPEC_AWARE_TRAIT, guidance: SPEC_AWARE_GUIDANCE })
}

registerStandardTraits()
