import type {
  AgentArchetype,
  AgentCategory,
  AgentKind,
  BlockStatus,
  BlockType,
} from '~/types/domain'

/** Simple unique id helper (fine for a client-only prototype). */
export function uid(prefix = 'id'): string {
  return `${prefix}_${Math.random().toString(36).slice(2, 9)}`
}

/**
 * Ordered palette categories — the collapsible sections the pipeline builder groups the
 * agent archetypes under. The order here is the order they render.
 */
export const AGENT_CATEGORIES: { id: AgentCategory; label: string }[] = [
  { id: 'review', label: 'Review & triage' },
  { id: 'design', label: 'Design & research' },
  { id: 'build', label: 'Implementation' },
  { id: 'test', label: 'Testing' },
  { id: 'docs', label: 'Documentation' },
  { id: 'gates', label: 'Gates & observability' },
]

/** The agent palette — the building blocks of a development pipeline, grouped by category. */
export const AGENT_ARCHETYPES: AgentArchetype[] = [
  {
    kind: 'requirements-review',
    label: 'Requirements Reviewer',
    icon: 'i-lucide-clipboard-check',
    color: '#f59e0b',
    category: 'review',
    description:
      'Reviews the collected context (description + linked PRDs/RFCs) for gaps, ambiguities, assumptions and risks before the architect starts.',
    // Opens the dedicated structured review window (answer/dismiss findings → incorporate
    // → re-review loop) instead of the generic prose step-detail panel.
    resultView: 'requirements-review',
  },
  {
    kind: 'clarity-review',
    label: 'Clarity Reviewer',
    icon: 'i-lucide-bug',
    color: '#f59e0b',
    category: 'review',
    description:
      'Triages a bug report for fixability — raising questions, gaps and assumptions about the report before anyone starts fixing it.',
    // Opens the dedicated structured review window (answer/dismiss findings → incorporate
    // → re-review loop) instead of the generic prose step-detail panel.
    resultView: 'clarity-review',
  },
  {
    // A read-only `/explore` agent (like the architect), so it's a first-class palette block
    // a user can add to any pipeline — not just the `pl_bugfix` preset where it leads. No
    // `resultView`: the enriched report is prose, so it uses the generic step-detail panel.
    kind: 'bug-investigator',
    label: 'Bug Investigator',
    icon: 'i-lucide-search-code',
    color: '#38bdf8',
    category: 'review',
    description:
      'Read-only codebase investigation that traces the bug to its root cause and produces an enriched report (no code changes).',
  },
  {
    kind: 'task-estimator',
    label: 'Task Estimator',
    icon: 'i-lucide-gauge',
    color: '#eab308',
    category: 'review',
    description:
      'Triages the task after requirements are clarified — rates Complexity, Risk and Impact (0..1). Used to gate consensus and conditional companion steps, and shown as ratings on the task.',
  },
  {
    kind: 'architect',
    label: 'Architect',
    icon: 'i-lucide-drafting-compass',
    color: '#a78bfa',
    category: 'design',
    description: 'Designs the shape of the solution and breaks down the work.',
  },
  {
    kind: 'researcher',
    label: 'Researcher',
    icon: 'i-lucide-telescope',
    color: '#38bdf8',
    category: 'design',
    description: 'Investigates prior art, libraries and constraints.',
  },
  {
    kind: 'coder',
    label: 'Coder',
    icon: 'i-lucide-code-xml',
    color: '#34d399',
    category: 'build',
    description: 'Implements the block according to the design.',
  },
  {
    kind: 'integrator',
    label: 'Integrator',
    icon: 'i-lucide-plug-zap',
    color: '#fb923c',
    category: 'build',
    description: 'Wires the block into the surrounding system.',
  },
  {
    kind: 'mocker',
    label: 'Mock Builder',
    icon: 'i-lucide-server-cog',
    color: '#fb7185',
    category: 'build',
    description: 'Builds WireMock mocks for external services and wires them into local/CI runs.',
  },
  {
    kind: 'tester',
    label: 'Tester',
    icon: 'i-lucide-flask-conical',
    color: '#fbbf24',
    category: 'test',
    description: 'Exercises the change against the mocks + spec scenarios and reports outcomes.',
    // Opens the dedicated structured test-report window (scenarios → outcomes →
    // concerns tree) instead of the generic prose step-detail panel.
    resultView: 'tester',
  },
  {
    kind: 'playwright',
    label: 'Acceptance Test Author',
    icon: 'i-lucide-theater',
    color: '#e879f9',
    category: 'test',
    description:
      "Turns scenarios into runnable tests — Playwright for frontend, the project's own framework for backend; adds only new ones.",
  },
  {
    kind: 'human-test',
    label: 'Human Testing',
    icon: 'i-lucide-user-check',
    color: '#f59e0b',
    category: 'test',
    description:
      'Spins up an ephemeral environment and pauses for a person to validate the change in a live URL — request a fix from findings, pull main + redeploy, or recreate/destroy the env — before the pipeline continues.',
    // Opens the dedicated human-testing window (env URL + confirm / request-fix / pull-main /
    // recreate / destroy) instead of the generic prose step-detail panel.
    resultView: 'human-test',
  },
  {
    kind: 'documenter',
    label: 'Documenter',
    icon: 'i-lucide-book-open-text',
    color: '#818cf8',
    category: 'docs',
    description: 'Produces docs and usage examples.',
  },
  {
    kind: 'business-documenter',
    label: 'Domain Rules Documenter',
    icon: 'i-lucide-scroll-text',
    color: '#84cc16',
    category: 'docs',
    description:
      'Reads the implementation and writes/updates business-logic & domain-rule docs in the repo, weaving in linked context documents.',
  },
  {
    kind: 'business-reviewer',
    label: 'Domain Rules Reviewer',
    icon: 'i-lucide-shield-alert',
    color: '#ef4444',
    category: 'docs',
    description:
      'Reviews a change against the documented domain rules and reports violations, undocumented changes and unexpected drift.',
  },
]

/**
 * Companion archetypes — dependent agents that review a specific producer and loop it back
 * for rework. They are NOT free palette blocks: the builder surfaces them as a toggle on
 * their producer step (a reviewer right after the coder it reviews), because a companion
 * makes no sense without its producer or anywhere else in the chain. They still need display
 * metadata (icons / labels) for the run timeline + saved-pipeline rendering, and their model
 * is pinnable, so they live here and are folded into {@link AGENT_BY_KIND}. See
 * {@link companionForProducer} for the producer→companion mapping (mirrors the backend
 * `COMPANIONS` registry).
 */
export const COMPANION_ARCHETYPES: AgentArchetype[] = [
  {
    kind: 'reviewer',
    label: 'Reviewer (companion)',
    icon: 'i-lucide-scan-eye',
    color: '#f472b6',
    description:
      "Coder's companion: rates the change for quality/correctness and loops it back for automatic rework below the threshold.",
  },
  {
    kind: 'architect-companion',
    label: 'Architect Companion',
    icon: 'i-lucide-bug-play',
    color: '#c084fc',
    description:
      "Challenges the architect's design for quality and completeness, looping it back for rework below the threshold before a human reviews it.",
  },
  {
    kind: 'spec-companion',
    label: 'Spec Reviewer',
    icon: 'i-lucide-list-checks',
    color: '#2dd4bf',
    description:
      'Reviews the spec — especially acceptance-scenario coverage — rating it and looping the Spec Writer back for automatic rework below the threshold, instead of requiring a human review.',
  },
]

/**
 * Producer agent kind → its companion agent kind. Mirrors the backend `COMPANIONS` registry
 * (`@cat-factory/agents`). The builder shows an "add companion" toggle on a producer step
 * found here, and inserts/removes the companion immediately after it.
 */
export const COMPANION_FOR_PRODUCER: Record<string, AgentKind> = {
  coder: 'reviewer',
  architect: 'architect-companion',
  'spec-writer': 'spec-companion',
}

const COMPANION_KINDS: ReadonlySet<string> = new Set(COMPANION_ARCHETYPES.map((a) => a.kind))

/** The companion kind that depends on a producer kind, or undefined if it has none. */
export function companionForProducer(kind: string): AgentKind | undefined {
  return COMPANION_FOR_PRODUCER[kind]
}

/**
 * Whether a kind is a dependent producer-companion (reviewer / architect-companion /
 * spec-companion) — rendered as a toggle on its producer, not a standalone palette block.
 * Distinct from `pipelineRender`'s `isCompanionKind`, which also counts the Tester's `fixer`.
 */
export function isProducerCompanion(kind: string): boolean {
  return COMPANION_KINDS.has(kind)
}

export const AGENT_BY_KIND: Record<AgentKind, AgentArchetype> = Object.fromEntries(
  [...AGENT_ARCHETYPES, ...COMPANION_ARCHETYPES].map((a) => [a.kind, a]),
) as Record<AgentKind, AgentArchetype>

/**
 * Agent kinds eligible for the optional consensus mechanism (the pipeline builder shows an
 * "Enable Consensus" toggle for these). Mirrors the backend default-eligible set assigned by
 * `registerConsensusTraits()` in `@cat-factory/consensus` — hand-synced, like the other
 * frontend mirrors. In CONSENSUS mode `architect`/`analysis` reason over the provided context
 * rather than exploring a checkout (a deliberate trade, gated by the task estimate).
 */
export const CONSENSUS_ELIGIBLE_KINDS: ReadonlySet<string> = new Set([
  'architect',
  'analysis',
  'reviewer',
  'task-estimator',
])

/** Whether a step kind can be flipped into the consensus execution mode. */
export function isConsensusEligibleKind(kind: string): boolean {
  return CONSENSUS_ELIGIBLE_KINDS.has(kind)
}

/**
 * Display metadata for the engine-driven "system" kinds — the gate/automation
 * steps (blueprint mapper, conflicts gate + resolver, CI gate + fixer, merger)
 * that appear in seeded pipelines and run timelines but are NOT user-addable
 * palette archetypes, so they're intentionally absent from {@link AGENT_ARCHETYPES}
 * / {@link AGENT_BY_KIND}. Looked up through {@link agentKindMeta}.
 */
export const SYSTEM_AGENT_META: Record<string, AgentArchetype> = {
  'spec-writer': {
    kind: 'spec-writer',
    label: 'Spec Writer',
    icon: 'i-lucide-clipboard-list',
    color: '#c084fc',
    description:
      "Aggregates every task's clarified requirements into the service's in-repo specification (spec.json) with full acceptance-scenario coverage, derived into Gherkin.",
  },
  blueprints: {
    kind: 'blueprints',
    label: 'Blueprinter',
    icon: 'i-lucide-map',
    color: '#22d3ee',
    description: 'Maps the repository into the service → modules blueprint.',
  },
  conflicts: {
    kind: 'conflicts',
    label: 'Conflicts Gate',
    icon: 'i-lucide-git-merge',
    color: '#f97316',
    description: 'Ensures the PR is mergeable with its base, looping the resolver on conflicts.',
    // Opens the dedicated gate window (verdict, attempts, conflict detail) instead of
    // the generic prose step-detail panel. Shared with the CI gate.
    resultView: 'gate',
  },
  'conflict-resolver': {
    kind: 'conflict-resolver',
    label: 'Conflict Resolver',
    icon: 'i-lucide-git-merge',
    color: '#f97316',
    description: 'Merges the base in and resolves conflicts on the PR branch.',
  },
  ci: {
    kind: 'ci',
    label: 'CI Gate',
    icon: 'i-lucide-shield-check',
    color: '#38bdf8',
    description: 'Gates the PR on green CI, looping the CI fixer on failure.',
    // Opens the dedicated gate window (verdict, attempts, the failing checks) instead
    // of the generic prose step-detail panel. Shared with the conflicts gate.
    resultView: 'gate',
  },
  'ci-fixer': {
    kind: 'ci-fixer',
    label: 'CI Fixer',
    icon: 'i-lucide-wrench',
    color: '#38bdf8',
    description: 'Fixes failing CI and pushes back to the PR branch.',
  },
  fixer: {
    kind: 'fixer',
    label: 'Fixer',
    icon: 'i-lucide-wrench',
    color: '#fbbf24',
    description:
      "Tester's companion: fixes the bugs the tester found and pushes back, then the tester re-runs.",
  },
  merger: {
    kind: 'merger',
    label: 'Merger',
    icon: 'i-lucide-git-pull-request',
    color: '#a3e635',
    description: 'Scores the PR and auto-merges within the task thresholds, or asks for review.',
  },
  // The Kaizen agent grades agent steps AFTER a run completes (continuous improvement).
  // It is NOT a pipeline step (never in the palette — no `category`), but it runs an LLM,
  // so it needs display metadata here and a per-workspace model in Model Configuration.
  kaizen: {
    kind: 'kaizen',
    label: 'Kaizen',
    icon: 'i-lucide-sparkles',
    color: '#2dd4bf',
    description:
      'Grades each completed agent step (smooth vs chaotic) after a run and recommends prompt/model improvements.',
  },
  // A polling gate (no model of its own) that watches the released PR's observability
  // signals after merge and escalates to the on-call agent on a regression. NOT in any
  // default pipeline and NOT a standing palette archetype — the palette surfaces it
  // conditionally (only with an observability integration connected, see AgentPalette),
  // but it still needs display metadata here so timelines/saved pipelines render it.
  'post-release-health': {
    kind: 'post-release-health',
    label: 'Post-Release Health',
    icon: 'i-lucide-activity',
    color: '#f43f5e',
    category: 'gates',
    description:
      'Watches the released PR’s Datadog monitors/SLOs after merge and escalates to the on-call agent on a regression.',
    // Opens the dedicated gate window (verdict, attempts, watch window) like the other gates.
    resultView: 'gate',
  },
}

/**
 * The observability-gated palette block. NOT in {@link AGENT_ARCHETYPES} (so it never
 * pollutes model-defaults — it runs no model — and is never offered unconditionally):
 * the pipeline builder appends it to the palette ONLY when the workspace has an
 * observability integration connected, and the backend rejects it otherwise.
 */
export const OBSERVABILITY_GATE_ARCHETYPE: AgentArchetype =
  SYSTEM_AGENT_META['post-release-health']!

/**
 * Engine-driven kinds that still run an LLM, so their model is worth pinning per
 * workspace even though they aren't user-addable palette archetypes. Surfaced in the
 * Default Models settings alongside {@link AGENT_ARCHETYPES} (but NOT in the pipeline
 * palette). The pure gates (`ci`, `conflicts`) are excluded — they run no model, so a
 * default model would do nothing for them.
 */
export const MODEL_CONFIGURABLE_SYSTEM_KINDS: AgentArchetype[] = [
  ...[
    'spec-writer',
    'blueprints',
    'conflict-resolver',
    'ci-fixer',
    'fixer',
    'merger',
    'kaizen',
  ].map((kind) => SYSTEM_AGENT_META[kind]!),
  // Companions run LLMs but aren't palette-addable (they're producer toggles), so include
  // them here to keep their per-workspace default model pinnable in the Model Defaults panel.
  ...COMPANION_ARCHETYPES,
]

/** Fallback metadata for any kind with no archetype or system entry (unknown/custom). */
const FALLBACK_AGENT_META: Omit<AgentArchetype, 'kind'> = {
  label: 'Agent',
  icon: 'i-lucide-bot',
  color: '#94a3b8',
  description: 'Agent step.',
}

/**
 * Resolve display metadata for ANY agent kind — a palette archetype (incl. custom
 * agents registered into {@link AGENT_BY_KIND}), an engine system kind, or an
 * unknown one — ALWAYS returning a usable icon/label/color. This is the single
 * lookup every pipeline / run renderer should use so a kind missing from the
 * archetype map (e.g. `ci`/`merger`/`blueprints` in a seeded pipeline) can never
 * blow up a component with an undefined access.
 */
export function agentKindMeta(kind: string): AgentArchetype {
  return (
    AGENT_BY_KIND[kind as AgentKind] ??
    SYSTEM_AGENT_META[kind] ?? { kind: kind as AgentKind, ...FALLBACK_AGENT_META }
  )
}

type BlockTypeMeta = { label: string; icon: string; accent: string }

/** Visual metadata for each architecture block type. */
export const BLOCK_TYPE_META: Record<BlockType, BlockTypeMeta> = {
  frontend: { label: 'Frontend', icon: 'i-lucide-monitor', accent: '#60a5fa' },
  service: { label: 'Service', icon: 'i-lucide-server', accent: '#a78bfa' },
  api: { label: 'API', icon: 'i-lucide-route', accent: '#22d3ee' },
  database: { label: 'Database', icon: 'i-lucide-database', accent: '#34d399' },
  queue: { label: 'Queue', icon: 'i-lucide-list-ordered', accent: '#fbbf24' },
  integration: {
    label: 'Integration',
    icon: 'i-lucide-workflow',
    accent: '#fb923c',
  },
  // Not user-creatable, but still emitted by the backend (the seeded third-party
  // service and the environments integration), so they need display metadata.
  external: { label: 'External', icon: 'i-lucide-globe', accent: '#94a3b8' },
  environment: { label: 'Environment', icon: 'i-lucide-box', accent: '#2dd4bf' },
}

const FALLBACK_BLOCK_TYPE_META: BlockTypeMeta = {
  label: 'Block',
  icon: 'i-lucide-box',
  accent: '#94a3b8',
}

/**
 * Visual metadata for a block type, with a safe fallback for any unknown/legacy
 * type so the board never crashes on a type the backend introduces ahead of the SPA.
 */
export function blockTypeMeta(type: BlockType): BlockTypeMeta {
  return BLOCK_TYPE_META[type] ?? FALLBACK_BLOCK_TYPE_META
}

/** Color + iconography for each block status. */
export const STATUS_META: Record<
  BlockStatus,
  { label: string; color: string; chip: string; icon: string }
> = {
  planned: {
    label: 'Planned',
    color: '#64748b',
    chip: 'neutral',
    icon: 'i-lucide-circle-dashed',
  },
  ready: {
    label: 'Ready',
    color: '#3b82f6',
    chip: 'info',
    icon: 'i-lucide-circle-play',
  },
  in_progress: {
    label: 'In progress',
    color: '#6366f1',
    chip: 'primary',
    icon: 'i-lucide-loader',
  },
  blocked: {
    // Generic copy: `blocked` is overloaded — a run parks here for a human
    // decision, an approval gate, OR a terminal failure. Surfaces that know the
    // specific reason (TaskCard, the inspector) show the precise label/action;
    // this fallback must NOT imply a decision is the only thing it can be.
    label: 'Needs attention',
    color: '#f59e0b',
    chip: 'warning',
    icon: 'i-lucide-alert-triangle',
  },
  pr_ready: {
    label: 'PR ready',
    color: '#22c55e',
    chip: 'success',
    icon: 'i-lucide-git-pull-request',
  },
  done: {
    label: 'Done',
    color: '#16a34a',
    chip: 'success',
    icon: 'i-lucide-circle-check',
  },
}

/** Visual metadata for module sub-frames. */
export const MODULE_META = { icon: 'i-lucide-package', color: '#a78bfa' }
