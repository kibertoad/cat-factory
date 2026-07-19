import type { AgentRunContext } from '@cat-factory/kernel'
import type { AgentKindDefinition, AgentKindRegistry } from './registry.js'

// ---------------------------------------------------------------------------
// The container `blueprints` + `spec-writer` agent kinds.
//
// Both are read-only structured `container-explore` agents: they clone a checkout, read the
// repository (the existing `blueprints/` map / the committed `spec/` baseline) and return the
// COMPLETE updated tree as JSON — they make no commit themselves. The deterministic render +
// commit of the artifact is a BACKEND post-op (`blueprintPostOp` / `specPostOp`, run from
// `ExecutionService`), and `toRunResult` coerces the returned JSON into the engine's
// `blueprintService` / `spec` channel.
//
// They were two of the built-in container kinds still rendered by the bespoke
// `buildMigratedBuiltInBody` switch in `@cat-factory/server`; migrating them onto the public
// `registerAgentKind` seam (the refactoring-candidates.md #5 strangler) is what lets that switch
// shed its cases. Their kind ids are DEFINED here, next to the definition, and re-exported by
// orchestration's `ci.logic.ts` for the engine's existing call sites — the same pattern the
// inline reviewer/brainstorm ids use (agents can't import orchestration, so the definition owns
// the id). `systemPromptFor` supplies the role prompt + the surface-driven directives
// (READ_ONLY_GUARDRAIL / FINAL_ANSWER_IN_REPLY), so the constants below deliberately do NOT
// restate the read-only guardrail or the final-answer directive — the single source of truth
// for both is the surface. Post-ops stay in the engine's built-in map (their commit
// branch is resolved specially — see `RunDispatcher.builtInRepoOpBranch`), so these definitions
// carry no `postOps` and no `presentation` (they are pipeline-internal, not palette kinds).
// ---------------------------------------------------------------------------

/** The agent kind of the container agent that maps a repository into the canonical
 * service → modules blueprint and (re)generates the in-repo `blueprints/` artifact. */
export const BLUEPRINTS_AGENT_KIND = 'blueprints'

/** The agent kind of the container agent that maintains the service's prescriptive, in-repo
 * specification under `spec/`, applying one task's requirements as an increment. */
export const SPEC_WRITER_AGENT_KIND = 'spec-writer'

/** Role prompt the Blueprinter step's agent runs under (returns the tree as JSON). */
const BLUEPRINT_SYSTEM_PROMPT =
  'You are a Domain-Driven Design architect mapping this repository. Decompose it ' +
  'into ONE top-level service and the modules inside it, where each module is a ' +
  'DOMAIN — a cohesive area of the BUSINESS, in the language of the problem space ' +
  '(a DDD bounded context / aggregate / subdomain). Name modules after business ' +
  'concepts, not technical layers. ' +
  'A module MUST represent a business capability or domain model (e.g. Billing, ' +
  'Catalog, Ordering, Identity), NOT a technical layer or shape: "api", "routes", ' +
  '"controllers", "utils", "helpers", "lib", "common", "config", "types", "models", ' +
  '"db" and the like are NOT domains and MUST NOT be modules. ' +
  'Group the genuinely non-business, technical/cross-cutting plumbing (persistence ' +
  'wiring, HTTP/transport, logging, configuration, auth middleware, build/deploy, ' +
  'shared utilities) into a SINGLE module named "infrastructure" rather than ' +
  'scattering it into many technical modules. ' +
  'Prefer organising code by domain (the ubiquitous language) over organising by ' +
  'file type. Anchor every node to the codebase with explicit repo-relative ' +
  'file/directory references. Keep names short and descriptive. ' +
  'Respond with ONLY a JSON object of shape {"type","name","summary","references":[],' +
  '"modules":[{"name","summary","references":[]}]} — no prose, no code fences.'

/** Role prompt the spec-writer step runs under (returns the spec doc as JSON). */
const SPEC_WRITER_SYSTEM_PROMPT =
  'You maintain the PRESCRIPTIVE specification for a service. READ the specification ' +
  'already committed to the repository under `spec/` (the baseline): start with ' +
  '`spec/overview.md` for the module → feature index, then open the relevant ' +
  '`spec/modules/<module>/<feature>.json` shards for the detail you need. You are also ' +
  'given the ' +
  'requirements of ONE task. Apply that task as an INCREMENT onto the baseline: add ' +
  'requirements for what the task introduces, and adjust existing requirements ONLY ' +
  'where the task changes their expected behaviour. Leave every other part of the ' +
  'baseline spec untouched. Translate ONLY what the task requirements state — do NOT ' +
  'invent requirements, fill gaps, or design beyond them (missing requirements are the ' +
  'requirements step’s job, not yours). ' +
  'The spec captures ONLY BUSINESS requirements — externally-observable behaviour, ' +
  'product rules and acceptance criteria. PURELY TECHNICAL work (a refactor, a ' +
  'dependency bump, internal restructuring, build/infra or other non-functional change ' +
  'that does NOT alter what the system does for its users) introduces no business ' +
  'requirements, and "NO NEW SPECS" is a valid, correct outcome for it: do NOT invent ' +
  'requirements to justify a change, and do NOT re-document technical/architecture ' +
  'detail here. When this task is purely technical, leave the baseline spec untouched ' +
  'and respond with ONLY {"noBusinessSpecs": true} (no other fields, no prose, no code ' +
  'fences). Otherwise return the full document as below. ' +
  'The spec is a two-level taxonomy: MODULES ' +
  '(domains, e.g. "Auth") each containing GROUPS (features, e.g. "Login"). Every ' +
  'requirement AND every domain rule lives inside a specific feature group: a group ' +
  'carries both its `requirements` and the `rules` scoped to it. There is NO catch-all — ' +
  'a cross-cutting concern goes in a `common` or `infrastructure` module that is ITSELF ' +
  'split into specific feature groups. CRUCIALLY, reuse the EXISTING taxonomy: place ' +
  'each new requirement/rule into the closest-fitting existing module and feature, ' +
  'reusing its EXACT name, and create a new module or feature ONLY when nothing fits — ' +
  'never a near-duplicate of an existing one (no "Authentication" beside "Auth", no ' +
  '"User Login" beside "Login"). Each requirement is phrased as "The system SHALL …" ' +
  'with a MoSCoW priority (must/should/could) and structured Given/When/Then acceptance ' +
  'criteria. Acceptance-scenario coverage is a FIRST-CLASS deliverable: every ' +
  'requirement the task adds or changes MUST carry complete acceptance criteria — the ' +
  'happy path AND the invalid-input / error / edge / boundary cases the requirements ' +
  'imply — since the Gherkin `.feature` files and the runnable tests are derived ' +
  'mechanically from them. Preserve the baseline’s existing `sourceBlockIds`; tag the ' +
  'requirements this task adds or changes with this task’s block id. Return the ' +
  'COMPLETE updated specification (baseline plus this increment), not a diff. The platform ' +
  'persists the specification you return, so returning it IS the whole job. Respond ' +
  'with ONLY a JSON object of ' +
  'shape {"service","summary","modules":[{"name","summary","groups":[{"name","summary",' +
  '"requirements":[{"id","title","statement","kind","priority","sourceBlockIds":[],' +
  '"acceptance":[{"id","given","when","outcome"}]}],"rules":[{"id","rule","rationale",' +
  '"sourceBlockIds":[]}]}]}]} ' +
  '(each acceptance criterion is a Given/When/Then, with the Then clause in `outcome`) — ' +
  'no prose, no code fences.'

/** Compact shape hint fed to the structured-output repair call for the blueprint tree. */
const BLUEPRINT_SHAPE_HINT =
  'Expected a service tree: {"type": string, "name": string, "summary": string, ' +
  '"references": string[], "modules": [{"name": string, "summary": string, ' +
  '"references": string[]}]}.'

/** Compact shape hint fed to the structured-output repair call for the spec doc. */
const SPEC_SHAPE_HINT =
  'Expected a requirements document with a two-level taxonomy — module (domain) → ' +
  'group (feature) — where each group carries BOTH its requirements and the domain ' +
  'rules scoped to it: {"service": string, "summary": string, "modules": [{"name": ' +
  'string, "summary": string, "groups": [{"name": string, "summary": string, ' +
  '"requirements": [{"id": string, "title": string, "statement": string, "kind": ' +
  'string, "priority": string, "sourceBlockIds": string[], "acceptance": [{"given": ' +
  'string, "when": string, "outcome": string}]}], "rules": [{"id": string, "rule": ' +
  'string, "rationale": string, "sourceBlockIds": string[]}]}]}]}. For a purely ' +
  'technical task with no business requirements, the document is instead just ' +
  '{"noBusinessSpecs": true}.'

/**
 * The Blueprinter's task prompt. The agent reads any existing blueprint from its own
 * read-only checkout (the harness no longer pre-injects the baseline tree), so the prompt
 * tells it to read `blueprints/` and update-or-create, then return the complete tree as
 * JSON. The backend `blueprintPostOp` renders + commits the artifact from that tree.
 */
export function blueprintUserPrompt(): string {
  return [
    'Map this repository into the canonical service → modules blueprint, anchored to real ' +
      'file/directory references.',
    '',
    'If a blueprint already exists in the repository (read `blueprints/blueprint.json` and ' +
      '`blueprints/overview.md`), UPDATE it to reflect the current code: keep accurate ' +
      'modules, add new ones, and refine summaries + references. Otherwise create it from ' +
      'scratch. Return the COMPLETE tree (not a diff).',
    '',
    'Respond with ONLY the JSON object for the service tree — no prose, no code fences.',
  ].join('\n')
}

/**
 * The spec-writer's task prompt — the instructions + baseline-read + taxonomy-reuse guidance
 * the bespoke harness `/spec` handler used to build. The agent reads the baseline from its own
 * read-only checkout under `spec/`, so the prompt tells it to read + reuse the existing taxonomy
 * rather than pre-injecting it. Carries ONLY this task's requirements (the block description IS
 * the task's reworked/incorporated requirements), so an unmerged sibling task's work never bleeds
 * in. The backend `specPostOp` shards + commits the returned tree.
 */
export function specWriterUserPrompt(context: AgentRunContext): string {
  const block = context.block
  const header = `### ${block.title || '(untitled task)'}${block.id ? ` (block ${block.id})` : ''}`
  // Honour an explicit human-set BUSINESS/TECHNICAL label: a task pinned business HAS
  // business requirements, so the "no new specs" escape hatch is withdrawn; a task pinned
  // technical is told the empty outcome is expected. Left unset, the writer self-determines.
  const technicalGuidance =
    block.technical === false
      ? 'This task is explicitly flagged BUSINESS: it HAS business requirements, so you MUST ' +
        'return the full updated specification. Do NOT respond with {"noBusinessSpecs": true}.'
      : block.technical === true
        ? 'This task is explicitly flagged TECHNICAL (a refactor / dependency bump / internal ' +
          'or non-functional change with NO new externally-observable behaviour): "no business ' +
          'requirements" is the expected outcome — respond with ONLY {"noBusinessSpecs": true} ' +
          'and change nothing, unless you find genuine externally-observable behaviour to spec.'
        : 'If this task is purely TECHNICAL (a refactor / dependency bump / internal or ' +
          'non-functional change that introduces NO new externally-observable behaviour), it ' +
          'has no business requirements: respond with ONLY {"noBusinessSpecs": true} and ' +
          'change nothing.'
  return [
    'Apply this ONE task as an INCREMENT onto the service specification.',
    '',
    'First READ the specification already committed to the repository under `spec/` (the ' +
      'baseline as merged before this task): open `spec/overview.md` for the module → feature ' +
      'index, then the relevant `spec/modules/<module>/<feature>.json` shards. Keep every part ' +
      'of the baseline this task does not touch exactly as-is, preserving its `sourceBlockIds`; ' +
      'adjust an existing requirement only where this task changes its behaviour. Map each new ' +
      'requirement/rule into the closest-fitting EXISTING module and feature, reusing its EXACT ' +
      'name — create a new module or feature ONLY when nothing fits (never a near-duplicate). ' +
      'If no spec exists yet, start one as a module (domain) → feature (group) taxonomy.',
    '',
    'Requirements for the ONE task to apply (its clarified description). Translate ONLY what ' +
      'these state into BUSINESS requirements (externally-observable behaviour, product rules, ' +
      'acceptance criteria) with COMPLETE acceptance-scenario coverage — do NOT invent ' +
      'requirements or fill gaps they leave:',
    '',
    `${header}\n\n${block.description?.trim() || '(no description)'}`,
    '',
    technicalGuidance +
      ' Otherwise return the COMPLETE updated document (baseline plus this task’s ' +
      'increment), not a diff. Respond with ONLY the JSON object — no prose, no code fences.',
  ].join('\n')
}

export const SPEC_BLUEPRINT_AGENT_KINDS: AgentKindDefinition[] = [
  // The Blueprinter runs as a read-only structured explore, cloning the PR branch when one is
  // open, else the repo's default branch (the generic `pr`-clone resolution), returning ONLY the
  // service tree as JSON. `toRunResult` coerces it into `blueprintService`; the deterministic
  // render + commit of the `blueprints/` artifact is the engine's `blueprintPostOp`.
  {
    kind: BLUEPRINTS_AGENT_KIND,
    systemPrompt: BLUEPRINT_SYSTEM_PROMPT,
    userPrompt: blueprintUserPrompt,
    agent: {
      surface: 'container-explore',
      clone: { branch: 'pr' },
      output: { kind: 'structured', shapeHint: BLUEPRINT_SHAPE_HINT },
    },
  },
  // The spec-writer runs as a read-only structured explore on the per-block WORK branch (clone
  // `work` — the deterministic `cat-factory/<blockId>` the coder resumes, created from base when
  // absent). It READS the baseline spec from its own checkout, applies this ONE task as an
  // increment, and returns the COMPLETE tree as JSON. `failOnUnusableFinal` because the doc is
  // handed onward to be sharded + committed by `specPostOp` — a truncated final answer must FAIL
  // LOUDLY rather than be laundered into a half-baked spec by the structured repair.
  {
    kind: SPEC_WRITER_AGENT_KIND,
    systemPrompt: SPEC_WRITER_SYSTEM_PROMPT,
    userPrompt: specWriterUserPrompt,
    agent: {
      surface: 'container-explore',
      clone: { branch: 'work' },
      output: { kind: 'structured', shapeHint: SPEC_SHAPE_HINT, failOnUnusableFinal: true },
    },
  },
]

/**
 * Register the blueprints + spec-writer kinds on the given registry. Called by
 * `defaultAgentKindRegistry()`; idempotent (the registry replaces by kind).
 */
export function registerSpecBlueprintAgents(registry: AgentKindRegistry): void {
  registry.registerAll(SPEC_BLUEPRINT_AGENT_KINDS)
}
