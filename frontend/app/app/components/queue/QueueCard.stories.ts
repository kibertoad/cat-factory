import type { Meta, StoryObj } from '@storybook/vue3'
import { startExecutionContract } from '@cat-factory/contracts'
import { expect, screen, userEvent, within } from 'storybook/test'
import { computed } from 'vue'
import { apiRefusal } from '~/stories/api'
import { loginTask, logoutTask, refreshTask } from '~/stories/board.stories.mocks'
import {
  auditTask,
  cookieTask,
  lockoutTask,
  queueSnapshot,
  resetTask,
  totpTask,
} from '~/stories/lanes.stories.mocks'
import { seedMember, seedSnapshot, withSeed } from '~/stories/withStores'
import { storyWorkspacePrefix } from '~/stories/workspace'
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

function board(select?: string, member = false) {
  return withSeed(() => {
    seedSnapshot(queueSnapshot())
    if (member) seedMember()
    if (select) useUiStore().select(select)
  })
}

// Start refused because the workspace has no handler for the service's provision type: a setup
// gap. The board admin who can fix it gets the toast's fix button; a member gets no button and
// one sentence naming who can fix it. The message is the run admission's own.
const startRefused = {
  api: [
    apiRefusal(startExecutionContract, {
      status: 409,
      error: {
        code: 'conflict',
        message:
          "This service provisions a 'kubernetes' environment via the Deployer, but this " +
          'workspace has no infrastructure handler configured for that type. Configure a ' +
          'handler (Infrastructure, Test environments), or set the service to infraless, before ' +
          'starting.',
        details: { reason: 'provision_type_unhandled', provisionType: 'kubernetes' },
      },
      pathPrefix: storyWorkspacePrefix,
      pathParams: { blockId: auditTask.id },
    }),
  ],
}

async function clickStart(canvasElement: HTMLElement) {
  await userEvent.click(within(canvasElement).getByRole('button', { name: 'Start' }))
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

/** Start refused on a setup gap, for a board admin: the toast offers the fix. */
export const StartRefused: Story = {
  args: { taskId: auditTask.id },
  decorators: [board()],
  parameters: startRefused,
  play: async ({ canvasElement }) => {
    await clickStart(canvasElement)
    await screen.findByRole('button', { name: 'Configure infrastructure' })
  },
}

/** The same refusal for a member: no fix button, and the toast names the board admin. */
export const StartRefusedMember: Story = {
  args: { taskId: auditTask.id },
  decorators: [board(undefined, true)],
  parameters: startRefused,
  play: async ({ canvasElement }) => {
    await clickStart(canvasElement)
    await screen.findByText(/A board admin can fix this\./)
    await expect(screen.queryByRole('button', { name: 'Configure infrastructure' })).toBeNull()
  },
}
