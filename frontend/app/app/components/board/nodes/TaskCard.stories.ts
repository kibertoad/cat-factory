import type { Meta, StoryObj } from '@storybook/vue3'
import {
  boardBlocks,
  boardWith,
  loginTask,
  logoutTask,
  rateLimitTask,
  refreshTask,
} from '~/stories/board.stories.mocks'
import { auditTask as audit } from '~/stories/lanes.stories.mocks'
import { execution, snapshot } from '~/stories/snapshot.stories.mocks'
import { withSnapshot } from '~/stories/withStores'
import TaskCard from './TaskCard.vue'

// A task on the board. It reads eight stores, so the stories fill them all from one workspace
// snapshot, the way the app does, rather than seeding each. A card takes only the task's id.
const running = { ...loginTask, executionId: 'exec_login' }

const meta = {
  title: 'Board/Components/TaskCard',
  component: TaskCard,
  parameters: { width: 'narrow' },
  decorators: [withSnapshot(snapshot({ blocks: boardWith(running), executions: [execution()] }))],
} satisfies Meta<typeof TaskCard>
export default meta

type Story = StoryObj<typeof meta>

/** A run in progress, at the coder step. */
export const Default: Story = { args: { taskId: running.id } }

/** Waiting on two dependencies, one of them unmerged. */
export const Blocked: Story = { args: { taskId: logoutTask.id } }

/** Planned with nothing in its way: the Run button. */
export const Ready: Story = {
  args: { taskId: audit.id },
  decorators: [withSnapshot(snapshot({ blocks: [...boardBlocks, audit] }))],
}

/** A pull request is open. */
export const PrReady: Story = {
  args: { taskId: rateLimitTask.id },
  decorators: [
    withSnapshot(
      snapshot({
        blocks: boardWith({
          ...rateLimitTask,
          pullRequest: { url: 'https://example.invalid/acme/gateway/pull/7', number: 7 },
        }),
      }),
    ),
  ],
}

/** Merged. */
export const Done: Story = { args: { taskId: refreshTask.id } }
