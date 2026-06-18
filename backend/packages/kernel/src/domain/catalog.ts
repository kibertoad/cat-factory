import type { BlockType } from './types'

// Static catalogs and constants used across the domain.

/**
 * The built-in merge threshold preset seeded for every workspace, used by any
 * task that hasn't picked its own. A PR auto-merges only when the `merger`
 * agent's complexity/risk/impact all stay at or below these ceilings; otherwise a
 * `merge_review` notification is raised. `ciMaxAttempts` bounds how many times the
 * `ci-fixer` agent retries before the CI gate gives up.
 */
export const DEFAULT_MERGE_PRESET = {
  name: 'Balanced',
  maxComplexity: 0.5,
  maxRisk: 0.4,
  maxImpact: 0.5,
  ciMaxAttempts: 10,
} as const

/** Fallback CI-fixer attempt budget when no preset resolves (defensive default). */
export const DEFAULT_CI_MAX_ATTEMPTS = DEFAULT_MERGE_PRESET.ciMaxAttempts

/** Human-facing label per block type, used when titling freshly dropped frames. */
export const BLOCK_TYPE_LABEL: Record<BlockType, string> = {
  frontend: 'Frontend',
  service: 'Service',
  api: 'API',
  database: 'Database',
  queue: 'Queue',
  integration: 'Integration',
  external: 'External',
  environment: 'Environment',
}
