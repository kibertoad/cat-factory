import type { Meta, StoryObj } from '@storybook/vue3'
import { parkedExecution, snapshot } from '~/stories/snapshot.stories.mocks'
import { seedSnapshot, withSeed } from '~/stories/withStores'
import { useWorkViewStore } from '~/stores/workView'
import WorkViewSwitcher from './WorkViewSwitcher.vue'

// The sidebar pair that switches the main area between the queue and the board. The queue shows
// how many tasks wait on a person, which the queue store derives from the board and its runs. So
// each story seeds the shared board with one run parked on the architect's plan: the login task
// waits for an approval, and the count is 1.
const meta = {
  title: 'Shell/Components/WorkViewSwitcher',
  component: WorkViewSwitcher,
  parameters: { width: 'narrow' },
  args: { collapsed: false },
  decorators: [withSeed(() => seedSnapshot(snapshot({ executions: [parkedExecution()] })))],
} satisfies Meta<typeof WorkViewSwitcher>
export default meta

type Story = StoryObj<typeof meta>

/** The board view on screen, and the queue with its count of tasks that need you. */
export const Default: Story = {
  decorators: [withSeed(() => useWorkViewStore().show('board'))],
}

/** The queue on screen. It is the view a user lands on before they choose. */
export const QueueActive: Story = {}

/** The collapsed sidebar: two icon buttons, with no title and no count. */
export const Collapsed: Story = {
  args: { collapsed: true },
  decorators: [withSeed(() => useWorkViewStore().show('board'))],
  render: (args) => ({
    components: { WorkViewSwitcher },
    setup: () => ({ args }),
    template: '<div class="w-14 px-2"><WorkViewSwitcher v-bind="args" /></div>',
  }),
}
