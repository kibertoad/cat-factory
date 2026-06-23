import type { AgentArchetype, AgentKind, BlockStatus, BlockType } from '~/types/domain'

/** Simple unique id helper (fine for a client-only prototype). */
export function uid(prefix = 'id'): string {
  return `${prefix}_${Math.random().toString(36).slice(2, 9)}`
}

/** The agent palette — the building blocks of a development pipeline. */
export const AGENT_ARCHETYPES: AgentArchetype[] = [
  {
    kind: 'requirements-review',
    label: 'Requirements Reviewer',
    icon: 'i-lucide-clipboard-check',
    color: '#f59e0b',
    description:
      'Reviews the collected context (description + linked PRDs/RFCs) for gaps, ambiguities, assumptions and risks before the architect starts.',
    // Opens the dedicated structured review window (answer/dismiss findings → incorporate
    // → re-review loop) instead of the generic prose step-detail panel.
    resultView: 'requirements-review',
  },
  {
    kind: 'architect',
    label: 'Architect',
    icon: 'i-lucide-drafting-compass',
    color: '#a78bfa',
    description: 'Designs the shape of the solution and breaks down the work.',
  },
  {
    kind: 'researcher',
    label: 'Researcher',
    icon: 'i-lucide-telescope',
    color: '#38bdf8',
    description: 'Investigates prior art, libraries and constraints.',
  },
  {
    kind: 'coder',
    label: 'Coder',
    icon: 'i-lucide-code-xml',
    color: '#34d399',
    description: 'Implements the block according to the design.',
  },
  {
    kind: 'tester',
    label: 'Tester',
    icon: 'i-lucide-flask-conical',
    color: '#fbbf24',
    description: 'Exercises the change against the mocks + spec scenarios and reports outcomes.',
    // Opens the dedicated structured test-report window (scenarios → outcomes →
    // concerns tree) instead of the generic prose step-detail panel.
    resultView: 'tester',
  },
  {
    kind: 'reviewer',
    label: 'Reviewer (companion)',
    icon: 'i-lucide-scan-eye',
    color: '#f472b6',
    description:
      "Coder's companion: rates the change for quality/correctness and loops it back for automatic rework below the threshold.",
  },
  {
    kind: 'documenter',
    label: 'Documenter',
    icon: 'i-lucide-book-open-text',
    color: '#818cf8',
    description: 'Produces docs and usage examples.',
  },
  {
    kind: 'integrator',
    label: 'Integrator',
    icon: 'i-lucide-plug-zap',
    color: '#fb923c',
    description: 'Wires the block into the surrounding system.',
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
    kind: 'playwright',
    label: 'Acceptance Test Author',
    icon: 'i-lucide-theater',
    color: '#e879f9',
    description:
      "Turns scenarios into runnable tests — Playwright for frontend, the project's own framework for backend; adds only new ones.",
  },
  {
    kind: 'mocker',
    label: 'Mock Builder',
    icon: 'i-lucide-server-cog',
    color: '#fb7185',
    description: 'Builds WireMock mocks for external services and wires them into local/CI runs.',
  },
  {
    kind: 'business-documenter',
    label: 'Domain Rules Documenter',
    icon: 'i-lucide-scroll-text',
    color: '#84cc16',
    description:
      'Reads the implementation and writes/updates business-logic & domain-rule docs in the repo, weaving in linked context documents.',
  },
  {
    kind: 'business-reviewer',
    label: 'Domain Rules Reviewer',
    icon: 'i-lucide-shield-alert',
    color: '#ef4444',
    description:
      'Reviews a change against the documented domain rules and reports violations, undocumented changes and unexpected drift.',
  },
]

export const AGENT_BY_KIND: Record<AgentKind, AgentArchetype> = Object.fromEntries(
  AGENT_ARCHETYPES.map((a) => [a.kind, a]),
) as Record<AgentKind, AgentArchetype>

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
}

/**
 * Engine-driven kinds that still run an LLM, so their model is worth pinning per
 * workspace even though they aren't user-addable palette archetypes. Surfaced in the
 * Default Models settings alongside {@link AGENT_ARCHETYPES} (but NOT in the pipeline
 * palette). The pure gates (`ci`, `conflicts`) are excluded — they run no model, so a
 * default model would do nothing for them.
 */
export const MODEL_CONFIGURABLE_SYSTEM_KINDS: AgentArchetype[] = [
  'spec-writer',
  'blueprints',
  'conflict-resolver',
  'ci-fixer',
  'fixer',
  'merger',
].map((kind) => SYSTEM_AGENT_META[kind]!)

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

/** Visual metadata for each architecture block type. */
export const BLOCK_TYPE_META: Record<BlockType, { label: string; icon: string; accent: string }> = {
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
  external: { label: 'External', icon: 'i-lucide-globe', accent: '#94a3b8' },
  environment: {
    label: 'Environment',
    icon: 'i-lucide-container',
    accent: '#2dd4bf',
  },
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
