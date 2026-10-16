import type { Meta, StoryObj } from '@storybook/vue3'
import type { ExecutionInstance, RunInputGate } from '@cat-factory/contracts'
import { listMergeClassRollupsContract } from '@cat-factory/contracts'
import { apiResponse } from '~/stories/api'
import { storyWorkspacePrefix } from '~/stories/workspace'
import { boardWith, loginTask } from '~/stories/board.stories.mocks'
import { mergeClassRollups } from '~/stories/mergeTrackRecord.stories.mocks'
import { approval, decision, failure, step, subtasks } from '~/stories/pipelineStep.stories.mocks'
import { claudeOnlyCatalog } from '~/stories/providers.stories.mocks'
import { execution, parkedExecution, snapshot } from '~/stories/snapshot.stories.mocks'
import { seedModelCatalog, seedSnapshot, withSeed } from '~/stories/withStores'
import type { Block } from '~/types/domain'
import TaskExecution from './TaskExecution.vue'

// The inspector's run section for a task: the pipeline's steps with their state, model and
// elapsed time, the button a parked step needs, Stop and Reset, and below them the failure, the
// pull request and the merge. The login task runs the board's build pipeline. A running step's
// clock counts from when the story opened, so its seconds move.
const minute = 60_000

/** The login task, linked to its run and with the board's other blocks around it. */
function withRun(run: ExecutionInstance | null, changes: Partial<Block> = {}) {
  return withSeed(() => {
    const task = { ...loginTask, executionId: run?.id ?? null, ...changes }
    seedSnapshot(snapshot({ blocks: boardWith(task), executions: run ? [run] : [] }))
    seedModelCatalog(claudeOnlyCatalog)
  })
}

/** The architect done in four minutes, and the coder on its plan, three of seven slices in. */
function runningBuild(overrides: Partial<ExecutionInstance> = {}): ExecutionInstance {
  const now = Date.now()
  return execution({
    steps: [
      step({
        agentKind: 'architect',
        state: 'done',
        progress: 1,
        model: 'anthropic:claude-opus-5',
        startedAt: now - 12 * minute,
        finishedAt: now - 8 * minute,
      }),
      step({
        agentKind: 'coder',
        state: 'working',
        progress: 0.4,
        model: 'anthropic:claude-opus-5',
        subtasks: subtasks(3, 7, 1),
        selectedFragmentIds: ['typescript-strict', 'testing-vitest'],
        startedAt: now - 8 * minute,
      }),
      step({ agentKind: 'pr-reviewer', state: 'pending', progress: 0 }),
    ],
    ...overrides,
  })
}

const pullRequest = {
  url: 'https://example.invalid/acme/auth-service/pull/42',
  number: 42,
  branch: 'cat-factory/login-endpoint',
}

const meta = {
  title: 'Inspector/Components/TaskExecution',
  component: TaskExecution,
  parameters: { width: 'panel' },
  args: { block: { ...loginTask, executionId: 'exec_login' } },
  decorators: [withRun(runningBuild())],
} satisfies Meta<typeof TaskExecution>
export default meta

type Story = StoryObj<typeof meta>

/** A running build: the architect done, the coder working with its slice count and standards. */
export const Default: Story = {}

/** No run, no pull request: the empty state. */
export const Empty: Story = {
  args: { block: loginTask },
  decorators: [withRun(null)],
}

/** The architect asks a question: Resolve on its row. */
export const NeedsDecision: Story = {
  decorators: [
    withRun(
      execution({
        steps: [
          step({ agentKind: 'architect', state: 'waiting_decision', decision: decision() }),
          step({ agentKind: 'coder', state: 'pending', progress: 0 }),
          step({ agentKind: 'pr-reviewer', state: 'pending', progress: 0 }),
        ],
        currentStep: 0,
        status: 'blocked',
      }),
    ),
  ],
}

/** The architect's plan waits for a person: Approve on its row. */
export const NeedsApproval: Story = { decorators: [withRun(parkedExecution())] }

/**
 * The container ran out of memory in the coder: the row reads Failed, and the failure card and
 * the earlier attempt's failure show below. The messages are made up.
 */
export const Failed: Story = {
  decorators: [
    withRun(
      runningBuild({
        status: 'failed',
        failure: failure({
          message: 'The container was evicted after 8 minutes of work and could not be recovered.',
          detail: 'exit code 137\nkilled: out of memory after 8m02s',
          stepIndex: 1,
          occurredAt: Date.now(),
        }),
        failureHistory: [failure({ kind: 'dispatch', message: 'Container failed to start.' })],
      }),
    ),
  ],
}

/** A dry run: the Dry run badge beside the pipeline name, because nothing will merge. */
export const DryRun: Story = { decorators: [withRun(runningBuild({ mode: 'dry_run' }))] }

const blockedGate: RunInputGate = {
  status: 'blocked',
  mode: 'standard',
  checkedAt: Date.UTC(2026, 9, 11, 9, 30),
  // A build task whose description is "TBD": the one finding the backend raises for it.
  issues: [{ code: 'description_placeholder', severity: 'blocking' }],
}

/**
 * The check before dispatch held the run: the notice above the steps, and no button on the
 * parked row, because the notice is where it is answered.
 */
export const InputGateParked: Story = {
  decorators: [
    withRun(
      execution({
        steps: [
          step({ agentKind: 'architect', state: 'working', progress: 0, approval: approval() }),
          step({ agentKind: 'coder', state: 'pending', progress: 0 }),
          step({ agentKind: 'pr-reviewer', state: 'pending', progress: 0 }),
        ],
        currentStep: 0,
        status: 'blocked',
        inputGate: blockedGate,
      }),
    ),
  ],
}

/** The run done and its pull request open: Read the result, the PR, the effort tags and Merge. */
export const AwaitingMerge: Story = {
  args: { block: { ...loginTask, executionId: 'exec_login', status: 'pr_ready', pullRequest } },
  decorators: [
    withRun(
      execution({
        steps: [
          step({ agentKind: 'architect', state: 'done', progress: 1 }),
          step({ agentKind: 'coder', state: 'done', progress: 1 }),
          step({ agentKind: 'pr-reviewer', state: 'done', progress: 1 }),
          step({
            agentKind: 'merger',
            state: 'done',
            progress: 1,
            custom: { changeClass: 'source' },
          }),
        ],
        currentStep: 3,
        status: 'done',
      }),
      { status: 'pr_ready', pullRequest },
    ),
  ],
  parameters: {
    api: [
      apiResponse(listMergeClassRollupsContract, {
        pathPrefix: storyWorkspacePrefix,
        body: mergeClassRollups,
      }),
    ],
  },
}

/** Merged, with the run long gone: Read the result and the merged pull request. */
export const Merged: Story = {
  args: { block: { ...loginTask, status: 'done', pullRequest } },
  decorators: [withRun(null, { status: 'done', pullRequest })],
}
