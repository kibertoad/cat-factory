import type { Meta, StoryObj } from '@storybook/vue3'
import type { ExecutionInstance } from '@cat-factory/contracts'
import { boardWith, loginTask } from '~/stories/board.stories.mocks'
import { prReview, step, subtasks } from '~/stories/pipelineStep.stories.mocks'
import { execution, parkedExecution, snapshot } from '~/stories/snapshot.stories.mocks'
import { seedSnapshot, withSeed } from '~/stories/withStores'
import { useTaskExpansionStore } from '~/stores/taskExpansion'
import { useUiStore } from '~/stores/ui'
import TaskPipelineMini from './TaskPipelineMini.vue'

// The run's steps inside a task card, shown while the pointer is on the card or once the board is
// zoomed to the steps band. One band deeper each step lists its todo items. A step opens its
// detail window on click, and a pending approval offers Review and approve. The story seeds the
// login task's run and either the hover or the zoom; the todo items are made up.
const coderTodo = {
  ...subtasks(2, 5, 1),
  items: [
    { label: 'Read the session middleware', status: 'completed' as const },
    { label: 'Add the refresh lock', status: 'completed' as const },
    { label: 'Rotate the refresh token on use', status: 'in_progress' as const },
    { label: 'Revoke the session family on reuse', status: 'pending' as const },
    { label: 'Tests for an expired token', status: 'pending' as const },
  ],
}

const coding = execution({
  steps: [
    step({ agentKind: 'architect', state: 'done', progress: 1 }),
    step({ agentKind: 'coder', state: 'working', progress: 0.4, subtasks: coderTodo }),
    step({ agentKind: 'pr-reviewer', state: 'pending', progress: 0 }),
  ],
})

/** The login task with `run`, and the card hovered or the board zoomed to `zoom`. */
function expanded(run: ExecutionInstance, { zoom }: { zoom?: number } = {}) {
  return withSeed(() => {
    seedSnapshot(
      snapshot({ blocks: boardWith({ ...loginTask, executionId: run.id }), executions: [run] }),
    )
    if (zoom) useUiStore().zoom = zoom
    else useTaskExpansionStore().setHovered(loginTask.id)
  })
}

const meta = {
  title: 'Board/Components/TaskPipelineMini',
  component: TaskPipelineMini,
  args: { taskId: loginTask.id },
  parameters: { width: 'narrow' },
} satisfies Meta<typeof TaskPipelineMini>
export default meta

type Story = StoryObj<typeof meta>

/** Hovered: the three steps, the coder's count of 2/5 and its bar. */
export const Default: Story = {
  decorators: [expanded(coding)],
}

/** Zoomed to the deepest band: the coder's todo items under its step. */
export const Subtasks: Story = {
  decorators: [expanded(coding, { zoom: 2.5 })],
}

/** The architect's plan waits for a person: Review and approve under its step. */
export const ApprovalPending: Story = {
  decorators: [expanded(parkedExecution())],
}

/**
 * The run failed while the coder was working. The coder keeps its 2/5 count, because a step with
 * todo items shows the count in place of its state icon, and the item in progress stops spinning
 * but keeps its in-progress icon: nothing in the list says the run failed.
 */
export const FailedRun: Story = {
  decorators: [expanded({ ...coding, status: 'failed' }, { zoom: 2.5 })],
}

/** The pull request reviewer is part way through: Reviewing 2/5 slices, in place of the count. */
export const PrReviewPhase: Story = {
  decorators: [
    expanded(
      execution({
        steps: [
          step({ agentKind: 'architect', state: 'done', progress: 1 }),
          step({ agentKind: 'coder', state: 'done', progress: 1 }),
          step({
            agentKind: 'pr-reviewer',
            state: 'working',
            progress: 0.4,
            prReview: prReview('reviewing'),
            subtasks: subtasks(2, 5, 1),
          }),
        ],
        currentStep: 2,
      }),
    ),
  ],
}

/** CI is red and its fixer is running: the CI step shows the CI fixer under it, spinning. */
export const CompanionRunning: Story = {
  decorators: [
    expanded(
      execution({
        steps: [
          step({ agentKind: 'coder', state: 'done', progress: 1 }),
          step({
            agentKind: 'ci',
            state: 'working',
            progress: 0.5,
            gate: { phase: 'working', attempts: 1, maxAttempts: 3 },
          }),
          step({ agentKind: 'merger', state: 'pending', progress: 0 }),
        ],
        currentStep: 1,
      }),
    ),
  ],
}
