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
  {
    kind: 'acceptance',
    label: 'Acceptance Author',
    icon: 'i-lucide-clipboard-check',
    color: '#2dd4bf',
    description: 'Turns requirements / PRDs into Given/When/Then acceptance scenarios.',
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
