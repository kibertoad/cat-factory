import type { Meta, StoryObj } from '@storybook/vue3'
import { computed } from 'vue'
import { loginTask, logoutTask, refreshTask } from '~/stories/board.stories.mocks'
import {
  auditTask,
  cookieTask,
  lockoutTask,
  queueSnapshot,
  resetTask,
  totpTask,
} from '~/stories/lanes.stories.mocks'
import { seedSnapshot, withSeed } from '~/stories/withStores'
import { useUiStore } from '~/stores/ui'
import { useWorkspaceQueueStore } from '~/stores/workspaceQueue'
import QueueCard from './QueueCard.vue'

// One task in the queue: why it is there, its service, and the one action for it. The queue
// files each task once (`useWorkspaceQueueStore`), and the card takes that entry, so the story
// fills the stores from the queue board (`queueSnapshot` in `lanes.stories.mocks.ts`) and passes
// the entry for the task it names. Every action sends a request or opens a window no story answers.
interface QueueCardArgs {
  taskId: string
}

const meta = {
  title: 'Board/Components/QueueCard',
  render: (args) => ({
    components: { QueueCard },
    setup() {
      const queue = useWorkspaceQueueStore()
      const entry = computed(() =>
        Object.values(queue.queue.sections)
          .flat()
          .find((e) => e.task.id === args.taskId)!,
      )
      return { entry }
    },
    template: '<QueueCard :entry="entry" />',
  }),
  args: { taskId: totpTask.id },
  parameters: { width: 'panel' },
} satisfies Meta<QueueCardArgs>
export default meta

type Story = StoryObj<typeof meta>

function board(select?: string) {
  return withSeed(() => {
    seedSnapshot(queueSnapshot())
    if (select) useUiStore().select(select)
  })
}

/** The architect asked where the TOTP secrets go: the question, and Answer. */
export const Default: Story = {
  decorators: [board()],
}

/** A run in progress: its bar, and the step it is on. */
export const Running: Story = {
  args: { taskId: loginTask.id },
  decorators: [board()],
}

/** The run failed: the failure card and its Retry, in place of an action. */
export const Failed: Story = {
  args: { taskId: resetTask.id },
  decorators: [board()],
}

/** The run is done and its pull request waits: the number in the eyebrow, Outcome and Merge. */
export const AwaitingMerge: Story = {
  args: { taskId: cookieTask.id },
  decorators: [board()],
}

/** A plan waits for approval: the action that opens it. */
export const AwaitingApproval: Story = {
  args: { taskId: lockoutTask.id },
  decorators: [board()],
}

/** Nobody started it, and nothing is in its way: Start. */
export const Unstarted: Story = {
  args: { taskId: auditTask.id },
  decorators: [board()],
}

/** Two tasks this one depends on, one not merged: what it waits on, and no action. */
export const Dependencies: Story = {
  args: { taskId: logoutTask.id },
  decorators: [board()],
}

/** Merged two days ago: how long ago, and no action. */
export const Merged: Story = {
  args: { taskId: refreshTask.id },
  decorators: [board()],
}

/** The inspector shows this task: the border is the strong one. */
export const Selected: Story = {
  decorators: [board(totpTask.id)],
}
