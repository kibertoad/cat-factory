import { SPEC_FEATURES_DIR, SPEC_MODULES_DIR, SPEC_OVERVIEW_PATH } from '@cat-factory/contracts'
import {
  type AgentKind,
  DOC_INTERVIEWER_AGENT_KIND,
  INITIATIVE_INTERVIEWER_AGENT_KIND,
} from '@cat-factory/kernel'
import type { AgentKindRegistry } from './registry.js'

// Agent traits: first-class, checkable CAPABILITIES an agent kind carries, beyond its
// role prompt. A trait both marks a kind for engine behaviour (e.g. `code-aware` tells
// the execution engine to fold the running service's selected best-practice fragments
// into the agent's system prompt) and can contribute fixed GUIDANCE appended to the
// kind's system prompt (e.g. `spec-aware` explains the in-repo `spec/` artifact).
//
// Built-in kinds get their traits from STANDARD_AGENT_TRAITS below; custom kinds declare
// theirs via `registerAgentKind({ traits })`. Custom trait DEFINITIONS (with their own
// guidance) and extra trait ASSIGNMENTS to existing kinds now live on the app-owned
// {@link AgentKindRegistry} instance (`registry.registerTrait` / `registry.assignTraits`),
// NOT a module-global `Map` — so module identity stops mattering for a separately-published
// extension package, and a test builds a fresh registry instead of calling a `clear*()`.

/** A trait id. Free-form so deployments can define their own beyond the standard two. */
export type AgentTrait = string

/**
 * Code-aware kinds read and/or change the service's code. The service's selected
 * best-practice / guideline fragments (Node, Fastify, performance, …) are folded into
 * their system prompt by the execution engine.
 */
export const CODE_AWARE_TRAIT: AgentTrait = 'code-aware'

/**
 * Doc-aware kinds AUTHOR or REVIEW a written document (the forward document-authoring
 * track). The block's selected writing-style fragments (the `style.*` collection —
 * anti-LLM-isms, concise & actionable) are folded into their system prompt by the
 * execution engine, the SAME way `code-aware` folds a service's technical fragments. This
 * is the trait gate that lets the doc kinds fold the style guidance without the prompt
 * builders special-casing them.
 */
export const DOC_AWARE_TRAIT: AgentTrait = 'doc-aware'

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

/**
 * Interview-gate kinds run the shared interactive-INTERVIEWER spine
 * (`InterviewGateController`): they PARK the run on a durable decision-wait while a human answers
 * the interviewer's clarifying questions in a dedicated window, then RESUME by re-running the
 * (slow) interviewer LLM in the durable driver — the human's `continue`/`proceed` records a
 * `pendingInterview` marker on the parked step and wakes the driver. A pure MARKER trait (no
 * prompt guidance): the execution engine reads it in TWO places — its step re-park guard lets a
 * resumed interview step (one carrying `pendingInterview`) fall through to the gate's own
 * evaluation instead of immediately re-parking, and the generic approve/reject guard refuses to
 * settle such a gate through the plain approval endpoint (it must go through the interview window).
 * A new interviewer just carries the trait instead of the engine hard-coding its kind.
 */
export const INTERVIEW_GATE_TRAIT: AgentTrait = 'interview-gate'

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
 *  - `doc-aware`: the document-authoring companion `doc-reviewer` (the writer/outliner/
 *    finalizer producer kinds are REGISTERED kinds, so they carry `doc-aware` on their own
 *    `AgentKindDefinition.traits` in `./document`, not here — the same way the code
 *    `reviewer` companion is a built-in listed here while the coder declares its own).
 */
export const STANDARD_AGENT_TRAITS: Partial<Record<AgentKind, AgentTrait[]>> = {
  architect: [CODE_AWARE_TRAIT, SPEC_AWARE_TRAIT],
  coder: [CODE_AWARE_TRAIT, SPEC_AWARE_TRAIT],
  reviewer: [CODE_AWARE_TRAIT, SPEC_AWARE_TRAIT],
  'ci-fixer': [CODE_AWARE_TRAIT, SPEC_AWARE_TRAIT],
  fixer: [CODE_AWARE_TRAIT, SPEC_AWARE_TRAIT],
  'conflict-resolver': [CODE_AWARE_TRAIT, SPEC_AWARE_TRAIT],
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
  // The document reviewer is a companion (no `AgentKindDefinition` of its own), so it
  // gets `doc-aware` here — folding the SAME writing-style fragments the writer received,
  // which become its review criteria (style guidance as both instruction and check).
  'doc-reviewer': [DOC_AWARE_TRAIT],
  // The interactive-interviewer gates ride the shared InterviewGateController park/resume spine;
  // the engine keys its re-park + approval-gate guards off this trait rather than their kind ids.
  [INITIATIVE_INTERVIEWER_AGENT_KIND]: [INTERVIEW_GATE_TRAIT],
  [DOC_INTERVIEWER_AGENT_KIND]: [INTERVIEW_GATE_TRAIT],
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

/**
 * The standard trait DEFINITIONS, pre-loaded onto every {@link AgentKindRegistry} instance
 * (its constructor installs them) — the analogue of `STANDARD_AGENT_TRAITS`, but for the
 * per-trait guidance. Only `spec-aware` carries guidance; the rest are pure markers whose
 * whole effect lives in the engine (the fragment fold / the interview-gate handling).
 */
export const STANDARD_TRAIT_DEFINITIONS: readonly AgentTraitDefinition[] = [
  { id: CODE_AWARE_TRAIT },
  { id: DOC_AWARE_TRAIT },
  { id: SPEC_AWARE_TRAIT, guidance: SPEC_AWARE_GUIDANCE },
  { id: INTERVIEW_GATE_TRAIT },
]

/**
 * The traits a kind carries: its built-in set ({@link STANDARD_AGENT_TRAITS}) unioned with a
 * registered kind's own `traits` and any extra assignments — both read off the app-owned
 * {@link AgentKindRegistry} instance, so there is no module-global state.
 */
export function traitsFor(kind: AgentKind, registry: AgentKindRegistry): Set<AgentTrait> {
  const traits = new Set<AgentTrait>(STANDARD_AGENT_TRAITS[kind] ?? [])
  for (const trait of registry.get(kind)?.traits ?? []) traits.add(trait)
  for (const trait of registry.assignedTraitsFor(kind)) traits.add(trait)
  return traits
}

/** Whether `kind` carries `trait`. */
export function hasTrait(kind: AgentKind, trait: AgentTrait, registry: AgentKindRegistry): boolean {
  return traitsFor(kind, registry).has(trait)
}

/**
 * The guidance lines contributed by the traits a kind carries, in trait order. Folded
 * into the kind's system prompt by `systemPromptFor`. Marker traits (no guidance, e.g.
 * `code-aware`) contribute nothing here. Trait definitions are read off the injected registry.
 */
export function traitGuidanceFor(kind: AgentKind, registry: AgentKindRegistry): string[] {
  const lines: string[] = []
  for (const trait of traitsFor(kind, registry)) {
    const guidance = registry.traitDefinition(trait)?.guidance
    if (!guidance) continue
    lines.push(typeof guidance === 'function' ? guidance(kind) : guidance)
  }
  return lines
}
