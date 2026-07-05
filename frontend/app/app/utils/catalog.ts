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
    // A read-only, structured `container-explore` agent, so it's a first-class palette block a
    // user can add to any pipeline — not just the `pl_bugfix` preset where it leads. Its
    // structured triage opens in the shared generic viewer; the clarity gate consumes its
    // `clarity`/`questions` server-side.
    kind: 'bug-investigator',
    label: 'Bug Investigator',
    icon: 'i-lucide-search-code',
    color: '#38bdf8',
    category: 'review',
    description:
      'Read-only, multi-repo codebase investigation that traces the bug to its root cause and decides whether the report is fixable as-is or needs the reporter to clarify (no code changes).',
    resultView: 'generic-structured',
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
    kind: 'requirements-brainstorm',
    label: 'Requirements Brainstorm',
    icon: 'i-lucide-lightbulb',
    color: '#f59e0b',
    category: 'design',
    description:
      'A structured dialogue that turns a rough idea into crisp requirements — proposing options with explicit trade-offs and letting you choose, before the requirements review.',
    // Opens the shared dedicated brainstorm window (propose options → choose → incorporate →
    // re-run loop) instead of the generic prose step-detail panel.
    resultView: 'brainstorm',
  },
  {
    kind: 'architecture-brainstorm',
    label: 'Architecture Brainstorm',
    icon: 'i-lucide-compass',
    color: '#a78bfa',
    category: 'design',
    description:
      'A structured dialogue that explores and finalizes a technical approach from the refined requirements — proposing options with explicit trade-offs and letting you converge, before the architect.',
    resultView: 'brainstorm',
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
    kind: 'tester-api',
    label: 'API Tester',
    icon: 'i-lucide-flask-conical',
    color: '#fbbf24',
    category: 'test',
    description: 'Exercises the change against the mocks + spec scenarios and reports outcomes.',
    // Opens the dedicated structured test-report window (scenarios → outcomes →
    // concerns tree) instead of the generic prose step-detail panel.
    resultView: 'tester',
  },
  {
    kind: 'tester-ui',
    label: 'UI Tester',
    icon: 'i-lucide-camera',
    color: '#fbbf24',
    category: 'test',
    description:
      'Drives a real browser through the new UI, captures a screenshot of each view, and reports outcomes.',
    // Same structured test-report window; it additionally renders the captured screenshots.
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
    kind: 'visual-confirmation',
    label: 'Visual Confirmation',
    icon: 'i-lucide-image-play',
    color: '#f59e0b',
    category: 'test',
    description:
      'Pauses for a person to review the UI tester’s screenshots against the uploaded reference designs — approve, or request a fix from findings — before the pipeline continues.',
    // Opens the dedicated visual-confirmation window (actual-vs-reference gallery + approve /
    // request-fix / recapture) instead of the generic prose step-detail panel.
    resultView: 'visual-confirm',
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
  {
    kind: 'doc-reviewer',
    label: 'Doc Reviewer',
    icon: 'i-lucide-file-search',
    color: '#818cf8',
    description:
      'Reviews the drafted document for completeness, clarity, accuracy and structure, looping the Doc Writer back for automatic rework below the threshold.',
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
  'doc-writer': 'doc-reviewer',
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
 * Whether an agent kind is one of the Tester gate kinds (API or UI). Mirrors the backend
 * `isTesterKind`; used by the pipeline builder to surface the test quality-control companion
 * toggle only on Tester steps.
 */
export function isTesterKind(kind: string): boolean {
  return kind === 'tester-api' || kind === 'tester-ui'
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
  // The Initiative Planning pipeline's two steps. Only runnable on an initiative
  // block (pl_initiative — enforced by the engine), so they are display-metadata
  // system kinds, never palette archetypes.
  'initiative-interviewer': {
    kind: 'initiative-interviewer',
    label: 'Initiative Interviewer',
    icon: 'i-lucide-messages-square',
    color: '#818cf8',
    description:
      'Interviews you on the goals, scope and constraints of the initiative, then synthesizes the agreed brief the analyst and planner build on.',
    // Opens the dedicated planning Q&A window (answer / continue / proceed) while parked.
    resultView: 'initiative-planning',
  },
  'initiative-analyst': {
    kind: 'initiative-analyst',
    label: 'Initiative Analyst',
    icon: 'i-lucide-microscope',
    color: '#818cf8',
    description:
      'Explores the codebase and writes an analysis (architecture, touch points, risks) that grounds the plan. Makes no changes.',
    resultView: 'initiative-tracker',
  },
  'initiative-planner': {
    kind: 'initiative-planner',
    label: 'Initiative Planner',
    icon: 'i-lucide-milestone',
    color: '#818cf8',
    description:
      "Explores the codebase and drafts the initiative's multi-phase plan (items, estimates, concurrency + pipeline policy) for approval.",
    // Opens the dedicated tracker window (phases / items / policy) instead of the
    // generic prose step-detail panel.
    resultView: 'initiative-tracker',
  },
  'initiative-committer': {
    kind: 'initiative-committer',
    label: 'Initiative Committer',
    icon: 'i-lucide-git-commit-horizontal',
    color: '#818cf8',
    description:
      'Persists the approved plan and commits the in-repo tracker (docs/initiatives/<slug>/), arming the execution loop. Runs no model.',
    resultView: 'initiative-tracker',
  },
  // A read-only repository audit that emits a prioritized findings report. Not a palette
  // archetype (it is only seeded into the recurring tech-debt pipeline), so it lives here
  // for run-timeline / saved-pipeline display rather than in AGENT_ARCHETYPES.
  analysis: {
    kind: 'analysis',
    label: 'Analyst',
    icon: 'i-lucide-search-code',
    color: '#818cf8',
    description:
      'Audits the repository read-only and emits a prioritized findings report (drives the tech-debt pipeline).',
  },
  // A one-shot engine step that files a tracker ticket (GitHub issue / Jira) from the
  // preceding analysis before implementation. Runs no model itself; seeded only into the
  // tech-debt pipeline, so it is a display-metadata system kind, not a palette archetype.
  tracker: {
    kind: 'tracker',
    label: 'Issue Tracker',
    icon: 'i-lucide-ticket',
    color: '#fb923c',
    description:
      'Files a tracker ticket (GitHub issue / Jira) from the analysis before work starts.',
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
  // The forward document pipelines' structural gate. Seed-only (no `category`, like ci /
  // conflicts) — it's part of `pl_document(_quick)`, not a standing palette block — but it
  // needs display metadata so timelines/saved pipelines render it. Its helper `doc-fixer`
  // is a registered kind, so it arrives via the workspace snapshot's `customAgentKinds`.
  'doc-quality': {
    kind: 'doc-quality',
    label: 'Doc Quality Gate',
    icon: 'i-lucide-file-check-2',
    color: '#818cf8',
    description:
      'Checks the drafted document for required sections, placeholders, links and heading structure, looping the doc fixer on problems.',
    // Opens the dedicated gate window (verdict, attempts, the document findings).
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
    // The merger's verdict is structured (scores + the engine's auto-merge / review
    // decision), so it opens a dedicated result view instead of the raw-JSON prose panel.
    resultView: 'merger',
  },
  'human-review': {
    kind: 'human-review',
    label: 'Human Review Gate',
    icon: 'i-lucide-users',
    color: '#c084fc',
    category: 'gates',
    description:
      'Waits for a human code review on the PR, looping the fixer to address comments; advances once approved with no unresolved threads.',
    // Opens the dedicated gate window (approval progress, the feedback being fixed, and a
    // freeform "request a fix" box) like the other gates.
    resultView: 'gate',
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
    'initiative-planner',
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

/**
 * Whether an agent kind is actually known to this build — a palette archetype or companion
 * ({@link AGENT_BY_KIND}, which deployment custom kinds are merged into via
 * `useAgentsStore().registerCustomKinds`), or an engine system/gate kind
 * ({@link SYSTEM_AGENT_META}). Unlike {@link agentKindMeta} (which always returns a usable
 * fallback so renderers never crash), this returns `false` for an unknown kind — used to flag
 * a pipeline that references a nonexistent agent. Call AFTER custom kinds are registered.
 */
export function isKnownAgentKind(kind: string): boolean {
  return kind in AGENT_BY_KIND || kind in SYSTEM_AGENT_META
}

type BlockTypeMeta = { label: string; icon: string; accent: string }

/** Visual metadata for each architecture block type. */
export const BLOCK_TYPE_META: Record<BlockType, BlockTypeMeta> = {
  frontend: { label: 'Frontend', icon: 'i-lucide-monitor', accent: '#60a5fa' },
  service: { label: 'Service', icon: 'i-lucide-server', accent: '#a78bfa' },
  library: { label: 'Library', icon: 'i-lucide-package', accent: '#f472b6' },
  document: { label: 'Document repository', icon: 'i-lucide-book-text', accent: '#c084fc' },
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

/**
 * Display metadata for the future-looking Follow-up companion — a per-`coder`-step toggle
 * (NOT a separate agent kind), so it isn't a palette archetype. It surfaces as a blinking
 * chip on the Coder step (its blinking is driven by `step.followUps` pending items) and as
 * the header of its dedicated window. The builder shows a toggle for it on Coder steps,
 * persisted on the pipeline's per-step `followUps` array.
 */
export const FOLLOW_UP_COMPANION_META = {
  label: 'Follow-up companion',
  icon: 'i-lucide-compass',
  color: '#f472b6',
}

/**
 * Whether a Coder step has the Follow-up companion enabled, given the pipeline's per-step
 * `followUps` toggle at index `i`. Enabled by default on a `coder` step (only `false`
 * disables it); ignored on other kinds.
 */
export function followUpCompanionEnabled(
  kind: string,
  followUps: (boolean | null)[] | undefined,
  i: number,
): boolean {
  return kind === 'coder' && followUps?.[i] !== false
}
