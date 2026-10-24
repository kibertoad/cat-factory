// A workspace snapshot over the shared board, for surfaces that read many stores at once.
//
// The app fills its stores from ONE snapshot (`useWorkspaceStore().hydrate`), so a story that
// does the same gets every store agreeing with every other, instead of eight seeds that each have
// to be kept consistent by hand. Only `workspace`, `blocks`, `pipelines` and `executions` are
// required; a story adds what its surface reads.
import type { ExecutionInstance, Pipeline, WorkspaceSnapshot } from '@cat-factory/contracts'
import { STORY_WORKSPACE_ID } from './workspace'
import { accountBoards } from './accounts.stories.mocks'
import { boardBlocks } from './board.stories.mocks'
import { approval, step } from './pipelineStep.stories.mocks'

/** The board's default interactive pipeline, which a card's Run button starts. */
export const buildPipeline: Pipeline = {
  id: 'pl_build',
  name: 'Build',
  purpose: 'build',
  agentKinds: ['architect', 'coder', 'pr-reviewer'],
  isDefault: true,
}

/** A run of the build pipeline, at the coder step. */
export function execution(overrides: Partial<ExecutionInstance> = {}): ExecutionInstance {
  return {
    id: 'exec_login',
    blockId: 'task_login',
    pipelineId: buildPipeline.id,
    pipelineName: buildPipeline.name,
    steps: [
      step({ agentKind: 'architect', state: 'done', progress: 1 }),
      step({ agentKind: 'coder', state: 'working', progress: 0.4 }),
      step({ agentKind: 'pr-reviewer', state: 'pending', progress: 0 }),
    ],
    currentStep: 1,
    status: 'running',
    ...overrides,
  }
}

/**
 * The same run parked on the architect's plan: the login task waits for a person to approve it,
 * so the queue counts it under "needs you" and the tours about answering a park unlock. A parked
 * run is `blocked`; a `running` one with a pending approval is still filed as running.
 */
export function parkedExecution(): ExecutionInstance {
  return execution({
    steps: [
      step({
        agentKind: 'architect',
        state: 'waiting_decision',
        progress: 1,
        approval: approval(),
      }),
      step({ agentKind: 'coder', state: 'pending', progress: 0 }),
      step({ agentKind: 'pr-reviewer', state: 'pending', progress: 0 }),
    ],
    currentStep: 0,
    status: 'blocked',
  })
}

// The story workspace as the workspaces list names it, so the board switcher and the snapshot
// agree on its name and its account.
const storyBoard = accountBoards.find((board) => board.id === STORY_WORKSPACE_ID)!

export function snapshot(overrides: Partial<WorkspaceSnapshot> = {}): WorkspaceSnapshot {
  return {
    workspace: {
      id: STORY_WORKSPACE_ID,
      name: storyBoard.name,
      description: storyBoard.description,
      createdAt: storyBoard.createdAt,
      accountId: storyBoard.accountId,
    },
    blocks: boardBlocks,
    pipelines: [buildPipeline],
    executions: [],
    ...overrides,
  }
}
