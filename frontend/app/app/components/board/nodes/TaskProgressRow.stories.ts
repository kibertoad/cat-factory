import type { Meta, StoryObj } from '@storybook/vue3'
import type { ExecutionInstance } from '@cat-factory/contracts'
import { boardWith, loginTask } from '~/stories/board.stories.mocks'
import { step } from '~/stories/pipelineStep.stories.mocks'
import { execution, parkedExecution, snapshot } from '~/stories/snapshot.stories.mocks'
import { seedSnapshot, withSeed } from '~/stories/withStores'
import TaskProgressRow from './TaskProgressRow.vue'

// Where an in-flight run is, on its task card: the step it is on, its position, and a segment
// per step coloured by state. The story seeds the login task's run.
function running(run: ExecutionInstance) {
  return withSeed(() => {
    seedSnapshot(
      snapshot({ blocks: boardWith({ ...loginTask, executionId: run.id }), executions: [run] }),
    )
  })
}

const meta = {
  title: 'Board/Components/TaskProgressRow',
  component: TaskProgressRow,
  args: { taskId: loginTask.id },
  parameters: { width: 'narrow' },
} satisfies Meta<typeof TaskProgressRow>
export default meta

type Story = StoryObj<typeof meta>

/** The coder is working, step 2 of 3: one done segment, one working, one pending. */
export const Default: Story = {
  decorators: [running(execution())],
}

/** The architect's plan waits for a person: its segment takes the warning colour. */
export const WaitingOnDecision: Story = {
  decorators: [running(parkedExecution())],
}

/** A long pipeline: nine segments still fit the card's width. */
export const LongPipeline: Story = {
  decorators: [
    running(
      execution({
        steps: [
          step({ agentKind: 'requirements-review', state: 'done', progress: 1 }),
          step({ agentKind: 'architect', state: 'done', progress: 1 }),
          step({ agentKind: 'coder', state: 'done', progress: 1 }),
          step({ agentKind: 'tester-ui', state: 'done', progress: 1 }),
          step({ agentKind: 'reviewer', state: 'working', progress: 0.5 }),
          step({ agentKind: 'ci', state: 'pending', progress: 0 }),
          step({ agentKind: 'pr-reviewer', state: 'pending', progress: 0 }),
          step({ agentKind: 'deployer', state: 'pending', progress: 0 }),
          step({ agentKind: 'merger', state: 'pending', progress: 0 }),
        ],
        currentStep: 4,
      }),
    ),
  ],
}
