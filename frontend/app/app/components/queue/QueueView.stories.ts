import type { Meta, StoryObj } from '@storybook/vue3'
import { screen, userEvent } from 'storybook/test'
import { gatewayService } from '~/stories/board.stories.mocks'
import { queueSnapshot, totpTask } from '~/stories/lanes.stories.mocks'
import { ciFailedCard } from '~/stories/notifications.stories.mocks'
import { snapshot } from '~/stories/snapshot.stories.mocks'
import { seedSnapshot, withSeed } from '~/stories/withStores'
import { useUiStore } from '~/stores/ui'
import { useWorkspaceQueueStore } from '~/stores/workspaceQueue'
import QueueView from './QueueView.vue'

// The queue: every task on the board in the column that says what it needs, read left to right
// from what waits on a person to what waits to merge. Work nobody started sits under In flight,
// and recent merges under Ready to merge behind a count. The header has the service filter, the
// inbox, which shows while it holds a card, and Describe work, which needs a service to put the
// work in. The tasks are the queue board (`queueSnapshot` in `lanes.stories.mocks.ts`), with one
// card in the inbox. The done count names the first day of the board's Done window, 14
// days before today, so its date moves with the clock. Every card action sends a request or opens
// a window no story answers.

function queue(seed: () => void = () => {}) {
  return withSeed(() => {
    seedSnapshot({ ...queueSnapshot(), notifications: [ciFailedCard] })
    seed()
  })
}

const meta = {
  title: 'Board/Pages/QueueView',
  component: QueueView,
  decorators: [queue()],
  parameters: { layout: 'fullscreen' },
} satisfies Meta<typeof QueueView>
export default meta

type Story = StoryObj<typeof meta>

/**
 * A failed run, a question and a plan need a person; the login run is in flight, with two tasks
 * not started under it; two pull requests wait to merge; one task merged in the window.
 */
export const Default: Story = {}

/**
 * A board with no service and no task: each column and the not started list say they are empty,
 * and Describe work does not show.
 */
export const Empty: Story = {
  decorators: [
    withSeed(() => {
      seedSnapshot(snapshot({ blocks: [] }))
    }),
  ],
}

/** Show opens the merges in the Done window under the count. */
export const DoneOpen: Story = {
  play: async () => {
    await userEvent.click(await screen.findByRole('button', { name: 'Show' }))
    await screen.findByRole('button', { name: 'Hide' })
  },
}

/** Filtered to API Gateway: its one task, waiting to merge. */
export const FilteredByService: Story = {
  decorators: [
    queue(() => {
      useWorkspaceQueueStore().serviceFilter = gatewayService.id
    }),
  ],
}

/**
 * A task selected: from the lg width the columns stop 22rem from the right, where the page puts
 * the inspector.
 */
export const InspectorOpen: Story = {
  decorators: [
    queue(() => {
      useUiStore().select(totpTask.id)
    }),
  ],
}
