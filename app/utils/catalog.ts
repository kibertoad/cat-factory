import type { AgentArchetype, AgentKind, BlockStatus, BlockType } from '~/types/domain'

/** Simple unique id helper (fine for a client-only prototype). */
export function uid(prefix = 'id'): string {
  return `${prefix}_${Math.random().toString(36).slice(2, 9)}`
}

/** The agent palette — the building blocks of a development pipeline. */
export const AGENT_ARCHETYPES: AgentArchetype[] = [
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
    description: 'Writes and runs tests, reports failures.',
  },
  {
    kind: 'reviewer',
    label: 'Reviewer',
    icon: 'i-lucide-scan-eye',
    color: '#f472b6',
    description: 'Reviews the implementation for quality and correctness.',
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
]

export const AGENT_BY_KIND: Record<AgentKind, AgentArchetype> = Object.fromEntries(
  AGENT_ARCHETYPES.map((a) => [a.kind, a]),
) as Record<AgentKind, AgentArchetype>

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
    label: 'Decision needed',
    color: '#f59e0b',
    chip: 'warning',
    icon: 'i-lucide-circle-help',
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

/** Default confidence threshold for a new task (auto-merge at/above this). */
export const DEFAULT_CONFIDENCE_THRESHOLD = 0.8

/** Visual metadata for module sub-frames. */
export const MODULE_META = { icon: 'i-lucide-package', color: '#a78bfa' }

/** Visual metadata for the "feature" tag tasks carry. */
export const FEATURE_META = { icon: 'i-lucide-puzzle', color: '#34d399' }

/** Sample task names used to seed / quick-add tasks inside a frame. */
export const TASK_NAME_BANK = [
  'Login endpoint',
  'Token refresh',
  'Password reset',
  'Session store',
  'Rate limiter',
  'Health checks',
  'Schema migration',
  'Error handling',
]

/** Candidate decisions an agent kind might surface (visualization only). */
export const DECISION_BANK: Partial<Record<AgentKind, { question: string; options: string[] }[]>> =
  {
    architect: [
      {
        question: 'Which persistence approach should this block use?',
        options: ['Relational (Postgres)', 'Document (Mongo)', 'Event-sourced'],
      },
      {
        question: 'Synchronous request or async event-driven?',
        options: ['Synchronous REST', 'Async via queue'],
      },
    ],
    researcher: [
      {
        question: 'Adopt an existing library or build in-house?',
        options: ['Use library', 'Build in-house', 'Defer decision'],
      },
    ],
    coder: [
      {
        question: 'Found an ambiguous edge case — how should we handle it?',
        options: ['Fail fast', 'Fallback to default', 'Ask product'],
      },
    ],
    tester: [
      {
        question: 'A flaky test keeps failing. Block or proceed?',
        options: ['Block on fix', 'Quarantine & proceed'],
      },
    ],
    reviewer: [
      {
        question: 'Review found a design smell. Refactor now or ticket it?',
        options: ['Refactor now', 'Create follow-up ticket'],
      },
    ],
    integrator: [
      {
        question: 'Downstream contract changed. How to roll out?',
        options: ['Versioned endpoint', 'Breaking change + migration'],
      },
    ],
  }
