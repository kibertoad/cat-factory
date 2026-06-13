import type { AgentKind, BlockType } from './types'

// Static catalogs and constants. The randomised pieces here (DECISION_BANK,
// DECISION_CHANCE) are consumed only by the SimulatorAgentExecutor, which
// reproduces the frontend's playful experience; the execution engine itself is
// deterministic and agent-driven.

/** Chance an in-flight simulator step raises a decision. */
export const DECISION_CHANCE = 0.18

/** Default confidence threshold for a new task (auto-merge at/above this). */
export const DEFAULT_CONFIDENCE_THRESHOLD = 0.8

/** Human-facing label per block type, used when titling freshly dropped frames. */
export const BLOCK_TYPE_LABEL: Record<BlockType, string> = {
  frontend: 'Frontend',
  service: 'Service',
  api: 'API',
  database: 'Database',
  queue: 'Queue',
  integration: 'Integration',
  external: 'External',
}

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
