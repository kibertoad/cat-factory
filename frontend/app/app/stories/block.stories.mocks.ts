// Shared story fixtures for a `Block`, the board's unit of work.
//
// A block carries far more than any one surface reads, so the base here is the REQUIRED set and
// nothing else. A story adds the part its component actually looks at, which keeps the fixture
// honest about what each surface depends on.
//
// Worth knowing before reaching for this: most block-rendering components are NOT reachable at the
// component story layer. `TaskLane` renders `LaneGroup`, which renders `LaneTask`, which renders
// `TaskCard`, and that reads eight stores. Those belong to a page or scene story with seeded
// state, not to a hand-built object.
import type { TaskEstimate } from '@cat-factory/contracts'
import type { Block } from '~/types/domain'

/** The smallest block the contract accepts. */
export function block(overrides: Partial<Block> = {}): Block {
  return {
    id: 'blk_login_endpoint',
    title: 'Login endpoint',
    type: 'service',
    description: 'Issue and refresh session tokens.',
    position: { x: 0, y: 0 },
    status: 'in_progress',
    // 0..1, like every score on a block. The card multiplies by 100.
    progress: 0.4,
    dependsOn: [],
    executionId: null,
    level: 'task',
    parentId: 'blk_auth_service',
    ...overrides,
  }
}

/**
 * A task estimate. `basis` distinguishes a PREDICTION from a measurement, and `supersedes` carries
 * what a re-estimate replaced, which is how a surface can show that a number moved.
 */
export function estimate(overrides: Partial<TaskEstimate> = {}): TaskEstimate {
  return {
    // 0..1 on all three axes.
    complexity: 0.6,
    risk: 0.4,
    impact: 0.7,
    rationale: 'Touches the session store and the transport, with no fixture for an expired token.',
    model: 'claude-opus-5',
    createdAt: Date.UTC(2026, 9, 11, 9, 0, 0),
    ...overrides,
  }
}
