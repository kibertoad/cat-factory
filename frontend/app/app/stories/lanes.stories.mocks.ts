// Auth Service with a task in every reason a lane files, for the swimlane stories. The shared board
// gives the running login task, the blocked log-out task and the merged token refresh; this adds a
// task nobody started, a pull request waiting to merge, a plan waiting for approval and a
// question waiting for an answer. Two of the new tasks are bugs, so grouping by type has a bug
// group beside the features. Four tasks sit in the Sessions module and three directly in the
// service, so grouping by module has a catch-all. The titles and the question are made up.
import type { ExecutionInstance, WorkspaceSnapshot } from '@cat-factory/contracts'
import type { Block } from '~/types/domain'
import { boardBlocks, loginTask, refreshTask } from './board.stories.mocks'
import { block } from './block.stories.mocks'
import { approval, decision, failure, step } from './pipelineStep.stories.mocks'
import { execution, snapshot } from './snapshot.stories.mocks'

export const auditTask = block({
  id: 'task_audit',
  title: 'Audit log for sign-ins',
  parentId: 'svc_auth',
  status: 'planned',
  progress: 0,
  taskType: 'feature',
})

export const cookieTask = block({
  id: 'task_cookie',
  title: 'Set SameSite on the session cookie',
  parentId: 'mod_sessions',
  status: 'pr_ready',
  progress: 1,
  taskType: 'bug',
  pullRequest: { url: 'https://example.invalid/acme/auth/pull/214', number: 214 },
})

export const lockoutTask = block({
  id: 'task_lockout',
  title: 'Lock the account after five failed sign-ins',
  parentId: 'mod_sessions',
  status: 'blocked',
  progress: 0.3,
  taskType: 'bug',
  executionId: 'exec_lockout',
})

export const totpTask = block({
  id: 'task_totp',
  title: 'TOTP as a second factor',
  parentId: 'svc_auth',
  status: 'blocked',
  progress: 0.2,
  taskType: 'feature',
  executionId: 'exec_totp',
})

const laneBlocks: Block[] = [
  ...boardBlocks.filter((b) => b.id !== loginTask.id),
  { ...loginTask, executionId: 'exec_login' },
  auditTask,
  cookieTask,
  lockoutTask,
  totpTask,
]

/** The lockout plan, parked on its approval. */
const lockoutRun: ExecutionInstance = execution({
  id: 'exec_lockout',
  blockId: lockoutTask.id,
  steps: [
    step({
      agentKind: 'architect',
      state: 'waiting_decision',
      progress: 1,
      approval: approval({ id: 'appr_lockout_plan' }),
    }),
    step({ agentKind: 'coder', state: 'pending', progress: 0 }),
    step({ agentKind: 'pr-reviewer', state: 'pending', progress: 0 }),
  ],
  currentStep: 0,
  status: 'blocked',
})

/** The TOTP architect, parked on a question. */
const totpRun: ExecutionInstance = execution({
  id: 'exec_totp',
  blockId: totpTask.id,
  steps: [
    step({
      agentKind: 'architect',
      state: 'waiting_decision',
      progress: 0.5,
      decision: decision({
        id: 'dec_totp_secret',
        question: 'Where are the TOTP secrets stored?',
        options: ['Encrypted in the users table', 'In the secrets vault, by user id'],
      }),
    }),
    step({ agentKind: 'coder', state: 'pending', progress: 0 }),
    step({ agentKind: 'pr-reviewer', state: 'pending', progress: 0 }),
  ],
  currentStep: 0,
  status: 'blocked',
})

/** The board, with each run, as one snapshot. */
export function laneSnapshot(overrides: Partial<WorkspaceSnapshot> = {}): WorkspaceSnapshot {
  return snapshot({
    blocks: laneBlocks,
    executions: [execution(), lockoutRun, totpRun],
    ...overrides,
  })
}

/** A task whose run failed at the coder step. */
export const resetTask = block({
  id: 'task_reset',
  title: 'Password reset email',
  parentId: 'svc_auth',
  status: 'blocked',
  progress: 0.3,
  executionId: 'exec_reset',
})

/**
 * The lane board for the queue, with the reset task's failed run and the token refresh merged two
 * days before `now`.
 */
export function queueSnapshot(now = Date.now()): WorkspaceSnapshot {
  const board = laneSnapshot()
  return {
    ...board,
    blocks: [
      ...board.blocks.map((b) =>
        b.id === refreshTask.id ? { ...b, completedAt: now - 2 * 86_400_000 } : b,
      ),
      resetTask,
    ],
    executions: [
      ...board.executions,
      execution({
        id: 'exec_reset',
        blockId: resetTask.id,
        steps: [
          step({ agentKind: 'architect', state: 'done', progress: 1 }),
          step({ agentKind: 'coder', state: 'working', progress: 0.3 }),
          step({ agentKind: 'pr-reviewer', state: 'pending', progress: 0 }),
        ],
        status: 'failed',
        failure: failure({
          message: 'The container was evicted after 14 minutes of work and could not be recovered.',
          stepIndex: 1,
        }),
      }),
    ],
  }
}
