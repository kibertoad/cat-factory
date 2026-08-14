import { SPEC_FEATURES_DIR, SPEC_MODULES_DIR, SPEC_OVERVIEW_PATH } from '@cat-factory/contracts'
import {
  type AgentKind,
  BINARY_OUTPUT_BRIEF_FILE,
  BINARY_OUTPUT_DECLARATION_TAG,
  DOC_INTERVIEWER_AGENT_KIND,
  FOUNDATIONAL_CATALOG_FILE,
  FOUNDATIONAL_CONTEXT_DIR,
  FOUNDATIONAL_DECLARATION_TAG,
  FOUNDATIONAL_INDEX_FILE,
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
 * Design-image kinds are handed the PICTURES of the task's designs, not just the textual
 * `.cat-context/` description of them: a kind that builds or plans a screen should see the screen.
 *
 * A pure MARKER trait: the engine reads it to decide whether a dispatch resolves the task's
 * reference set at all, which is what keeps the two reads (documents + artifact store) off the
 * dispatch path of every kind that has no use for them. Whether the pictures then REACH the model
 * is a separate, per-dispatch question (the harness and the resolved model), and one the trait
 * deliberately says nothing about: a kind carrying it on a text-only pair still resolves the set,
 * so its prompt can state what was withheld.
 *
 * Distinct from {@link BINARY_STORAGE_TRAIT}, which is a PRECONDITION (a run whose kind carries it
 * is refused when the account stores no binaries). This one is an ENRICHMENT: a task with no
 * linked design, or a deployment with no storage, is simply a run with no pictures, which is the
 * ordinary case and not a misconfiguration.
 */
export const DESIGN_IMAGES_TRAIT: AgentTrait = 'design-images'

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

/**
 * Implementer kinds: code-writing agents that run a LONG agentic loop (coder, fixer,
 * ci-fixer, conflict-resolver) whose system prompt — including every folded best-practice
 * standard — is re-sent on each of their many turns. A pure MARKER trait (no prompt
 * guidance): {@link standardsVerbosityFor} reads it to fold the CONDENSED `brief` variant of
 * each standard instead of the full `body`, cutting the per-turn (and cache-read) context
 * cost without dropping the standard. Reviewer / planner / investigator kinds (reviewer,
 * architect, on-call) deliberately DON'T carry it — they run few turns and benefit from the
 * full standard text when polishing/judging what was built. A custom kind opts in by carrying
 * the trait. Orthogonal to `standardsDelivery`: `context-files` kinds skip the fold entirely,
 * so the trait only affects kinds whose standards are folded into the prompt.
 */
export const BRIEF_STANDARDS_TRAIT: AgentTrait = 'brief-standards'

/**
 * DESIGN-time kinds that choose which shared FOUNDATIONAL SERVICES a solution consumes. The
 * engine injects the workspace's catalog (identity + capabilities + operation names, never a
 * contract document) as `.cat-context/foundational-services/catalog.md`, and the guidance below
 * requires the kind to declare the ids it designed against in a machine-readable block. That
 * declaration is what the downstream `foundational-contracts` kinds' lazy read keys off — the
 * whole point of splitting the two traits is that a design step pays for the cheap catalog and
 * only the services it actually picked cost anyone a document.
 */
export const FOUNDATIONAL_CATALOG_TRAIT: AgentTrait = 'foundational-catalog'

/**
 * CONSUMER kinds that need the API details of the services the design declared. The engine
 * resolves those ids to their full contract documents and injects one file per service. The
 * guidance points at the index rather than restating the catalog: a consumer must not be
 * choosing services, and handing it the whole catalog is how a coder ends up adopting a shared
 * service the design deliberately rejected.
 */
export const FOUNDATIONAL_CONTRACTS_TRAIT: AgentTrait = 'foundational-contracts'

/** The guidance a design-time kind gets: consult the catalog, then DECLARE what it used. */
export const FOUNDATIONAL_CATALOG_GUIDANCE = [
  `This deployment runs shared FOUNDATIONAL SERVICES — capabilities such as file storage, notifications or audit that already exist and that new systems are expected to CONSUME rather than rebuild. The catalog of what is available is provided to you as \`.cat-context/${FOUNDATIONAL_CATALOG_FILE}\`; read it before you settle on a design.`,
  `Prefer an existing foundational service over designing your own equivalent. When you reject one that looks applicable, say why — "we already have this" is the single most common avoidable finding in a design review.`,
  `The catalog lists each service's operations but NOT its full API documents. Design against the operations you can see; do not invent endpoints, fields or semantics the catalog does not show. The implementation steps get the full contracts.`,
  `END your reply with a fenced \`\`\`${FOUNDATIONAL_DECLARATION_TAG} block listing the service ids your design consumes, one per line, and nothing else in the block. Write \`none\` when your design consumes no foundational service. This block is machine-read: the ids you list are what the later implementation steps are handed the API contracts for, so a service you omit is one nobody downstream will have the interface to, and an id you invent will be reported as unavailable.`,
].join('\n')

/**
 * GENERATOR kinds whose deliverable is BINARY artifacts (image generation is the canonical
 * example) stored through a FOUNDATIONAL SERVICE the step selected from the workspace catalog
 * (`stepOptions.binaryOutput`) — never through the platform's own artifact store, which holds
 * run evidence, not product deliverables. The engine injects a brief naming the selected
 * storage service and the selected CONTEXT services (an inventory that can say which entities
 * exist, which lack an asset, and how each is described), each with its API contract, and reads
 * the agent's machine-readable declaration of what it stored back onto the step
 * (`PipelineStep.binaryOutputs`). The same selection names the GENERATIVE INTEGRATIONS the step
 * may call to produce those artifacts (`generatorIds`, from the deployment's code-registered
 * `BinaryGeneratorRegistry`) and the CONTENT TYPES it must deliver (`modalities`), which the
 * brief lays out per integration so an image generator is never asked for music. Run admission
 * refuses a step carrying this trait whose selection is missing, does not resolve against the
 * catalog/registry, or cannot cover a content type the step declares. No built-in kind carries
 * it — a deployment's generator opts in via `registerAgentKind({ traits })`.
 * See docs/initiatives/binary-output-foundational-storage.md.
 */
export const BINARY_OUTPUT_TRAIT: AgentTrait = 'binary-output'

/** The guidance a binary-generating kind gets: the brief, the workflow, and the declaration. */
export const BINARY_OUTPUT_GUIDANCE = [
  `Your deliverable is BINARY artifacts (images, audio, video or similar), produced through the generative integrations this step was given and stored through a shared storage service this deployment runs. Start from \`.cat-context/${BINARY_OUTPUT_BRIEF_FILE}\`: it names the integrations you may generate with (and the content types each one produces), the storage service to store through, any context services selected for this step, and where their API contracts are. If that file is absent, the platform could not provide storage — do not attempt any upload; state it in your report and stop generating.`,
  `Before generating, establish SCOPE from the selected context services (what entities exist, which already have an asset, what each thing's description says) rather than inventing subjects. Generate ONLY through the integrations the brief names, and only for the content types it says each one produces; a credential it names arrives as an environment variable, and an unset one means the platform could not provide it — report that instead of calling the API anyway. Store every artifact through the named storage service's contract — call the operations it declares, with the shapes it declares; never invent an endpoint, and never deliver binaries by committing them to the repository or embedding them in your reply.`,
  `END your reply with a fenced \`\`\`${BINARY_OUTPUT_DECLARATION_TAG} block containing either the literal \`none\` (you stored nothing) or a JSON array of entries \`{"service": "<service id>", "location": "<where the service stored it>", "generator": "<integration id that produced it>", "entity": "<what it is for>", "contentType": "<media type>", "description": "<one line>", "dimensions": {"width": <px>, "height": <px>}}\` — \`service\` and \`location\` are required, the rest optional. Report \`dimensions\` whenever the artifact has pixel dimensions and you know them, and ALWAYS when this step asked for an exact output size: it is the only record of what was actually delivered rather than what was asked for. This block is machine-read and recorded on the run; an artifact you omit is one nobody can find later. Anything you could NOT produce or store (an integration with no credential, a content type nothing available generates, a failed upload, a contract gap) belongs in your report as a named omission, never silently dropped.`,
].join('\n')

/** The guidance a consumer kind gets: the contracts are files, and they are authoritative. */
export const FOUNDATIONAL_CONTRACTS_GUIDANCE = [
  `The FOUNDATIONAL SERVICES the design chose for this task — shared capabilities such as file storage, notifications or audit — have their API contracts provided to you under \`.cat-context/${FOUNDATIONAL_CONTEXT_DIR}/\`. Start at \`.cat-context/${FOUNDATIONAL_INDEX_FILE}\`, which names each one and states anything the design asked for that could not be provided.`,
  `Treat those contracts as the authoritative interface: call the operations they declare, with the shapes they declare. Do not invent an endpoint or a field, and do not reimplement a capability one of these services already provides.`,
  `If the work needs something the provided contracts do not cover, say so in your report rather than guessing at the missing API.`,
].join('\n')

/** The guidance appended to a spec-aware kind's system prompt — explains the spec format. */
export const SPEC_AWARE_GUIDANCE = [
  `This repository may contain a prescriptive SPECIFICATION for the service under the \`spec/\` directory — the source of truth for what the service must do. It is sharded by a module (domain) → feature (group) taxonomy. When it is present, read it before doing the work:`,
  `- \`${SPEC_OVERVIEW_PATH}\` first, for the high-level product intent and an index of the modules and their features (with links).`,
  `- \`${SPEC_MODULES_DIR}/<module>/<feature>.md\` for the feature you are working on — its requirements and the domain rules scoped to it.`,
  `- \`${SPEC_MODULES_DIR}/<module>/<feature>.json\` is the canonical machine-readable shard the markdown is rendered from; consult it when you need exact detail.`,
  `- \`${SPEC_FEATURES_DIR}/<module>/<feature>.feature\` for the Gherkin (Given/When/Then) acceptance scenarios.`,
  // Kept to one imperative line ON PURPOSE: this rides the system prompt of every spec-aware
  // kind, re-sent on every turn of the implementer kinds whose per-turn cost the `brief`
  // standards exist to cut — so arguing the case at length here would spend back the saving.
  `Navigate, don't dredge: read \`${SPEC_OVERVIEW_PATH}\` to map the service, then open ONLY the shards for the feature(s) you are changing PLUS any module your change calls into or that depends on it. Reading the whole tree wastes your context budget; reading only your own shard breaks the neighbours you touch.`,
  `Treat the spec as authoritative for required behaviour: make your change satisfy it, and if your change conflicts with the spec, follow the spec or call out the discrepancy rather than silently diverging.`,
].join('\n')

/**
 * Built-in trait assignment per agent kind.
 *  - `code-aware`: the kinds that read/modify the service's code, so the service's
 *    best-practice fragments are relevant to them.
 *  - `spec-aware`: every code-touching kind (anything that clones and reads the repo),
 *    so each is pointed at the in-repo spec. The `spec-writer` is intentionally absent —
 *    it AUTHORS the spec rather than consuming it.
 *  - `design-images`: the kinds that build or plan a SCREEN, so a task's design renders are
 *    resolved and put in front of them where the harness/model pair can carry an image.
 *  - `doc-aware`: the document-authoring companion `doc-reviewer` (the writer/outliner/
 *    finalizer producer kinds are REGISTERED kinds, so they carry `doc-aware` on their own
 *    `AgentKindDefinition.traits` in `./document`, not here — the same way the code
 *    `reviewer` companion is a built-in listed here while the coder declares its own).
 */
export const STANDARD_AGENT_TRAITS: Partial<Record<AgentKind, AgentTrait[]>> = {
  // The architect DESIGNS, so it is the one built-in kind that chooses foundational services
  // and declares them; `researcher` and `coder` CONSUME that declaration.
  architect: [CODE_AWARE_TRAIT, SPEC_AWARE_TRAIT, FOUNDATIONAL_CATALOG_TRAIT, DESIGN_IMAGES_TRAIT],
  coder: [
    CODE_AWARE_TRAIT,
    SPEC_AWARE_TRAIT,
    BRIEF_STANDARDS_TRAIT,
    FOUNDATIONAL_CONTRACTS_TRAIT,
    DESIGN_IMAGES_TRAIT,
  ],
  // The researcher plans the solution against the design, so it needs the same contracts the
  // coder will build to — investigating prior art for a capability the org already runs, from
  // the catalog entry alone, is how a plan ends up proposing a library beside a shared service.
  researcher: [FOUNDATIONAL_CONTRACTS_TRAIT],
  reviewer: [CODE_AWARE_TRAIT, SPEC_AWARE_TRAIT],
  'ci-fixer': [CODE_AWARE_TRAIT, SPEC_AWARE_TRAIT, BRIEF_STANDARDS_TRAIT],
  // The fixer is the kind a visual-confirmation `request-fix` dispatches, so it is acting on a
  // human's "this does not match the design" the moment it runs: it needs the design as much as
  // the coder that produced the screen.
  fixer: [CODE_AWARE_TRAIT, SPEC_AWARE_TRAIT, BRIEF_STANDARDS_TRAIT, DESIGN_IMAGES_TRAIT],
  'conflict-resolver': [CODE_AWARE_TRAIT, SPEC_AWARE_TRAIT, BRIEF_STANDARDS_TRAIT],
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
 * per-trait guidance. The spec-aware / foundational / binary-output traits carry guidance;
 * the rest are pure markers whose whole effect lives in the engine (the fragment fold / the
 * interview-gate handling).
 */
export const STANDARD_TRAIT_DEFINITIONS: readonly AgentTraitDefinition[] = [
  { id: CODE_AWARE_TRAIT },
  { id: DOC_AWARE_TRAIT },
  { id: SPEC_AWARE_TRAIT, guidance: SPEC_AWARE_GUIDANCE },
  { id: INTERVIEW_GATE_TRAIT },
  { id: BRIEF_STANDARDS_TRAIT },
  { id: FOUNDATIONAL_CATALOG_TRAIT, guidance: FOUNDATIONAL_CATALOG_GUIDANCE },
  { id: FOUNDATIONAL_CONTRACTS_TRAIT, guidance: FOUNDATIONAL_CONTRACTS_GUIDANCE },
  { id: BINARY_OUTPUT_TRAIT, guidance: BINARY_OUTPUT_GUIDANCE },
  // A marker: the pictures are delivered as context (files or attached parts) and the prompt
  // section that names them is rendered from what the dispatch actually achieved, so there is no
  // static guidance to fold. Standing advice about consuming a design lives in the
  // `design.context` fragment, which the engine folds by the same presence rule.
  { id: DESIGN_IMAGES_TRAIT },
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
 * How verbose a kind's folded best-practice standards should be: `brief` for an implementer
 * kind (carries {@link BRIEF_STANDARDS_TRAIT}), `full` otherwise. Read at the dispatch
 * chokepoint (`buildKindBody`) and the inline executor, then threaded into
 * `composeBlockSystemPrompt`. Returns the literal union rather than importing the runtime
 * package's `StandardsVerbosity` type to keep `@cat-factory/agents/kinds` free of a runtime
 * dependency on the composer; the two unions are identical.
 */
export function standardsVerbosityFor(
  kind: AgentKind,
  registry: AgentKindRegistry,
): 'full' | 'brief' {
  return hasTrait(kind, BRIEF_STANDARDS_TRAIT, registry) ? 'brief' : 'full'
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
