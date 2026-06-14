import type { BlockType } from './types'

// Static catalogs and constants used across the domain.

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
  environment: 'Environment',
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
