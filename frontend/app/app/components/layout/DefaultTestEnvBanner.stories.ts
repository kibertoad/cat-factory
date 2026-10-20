import type { Meta, StoryObj } from '@storybook/vue3'
import { seedWorkspace, withSeed } from '~/stories/withStores'
import { useWorkspaceStore } from '~/stores/workspace'
import DefaultTestEnvBanner from './DefaultTestEnvBanner.vue'

// The prompt to pick the board's default test environment type, which every new service then
// starts from. It shows on a loaded board whose settings record no choice, to someone who may
// change the settings, until they dismiss it. The link under the button is the copyable address
// of the settings section; in Storybook it points at the story's own frame.
const meta = {
  title: 'Setup/Components/DefaultTestEnvBanner',
  component: DefaultTestEnvBanner,
  decorators: [
    withSeed(() => {
      seedWorkspace()
      useWorkspaceStore().ready = true
    }),
  ],
} satisfies Meta<typeof DefaultTestEnvBanner>
export default meta

type Story = StoryObj<typeof meta>

/** No default chosen yet: the card, the configure button and the settings address. */
export const Default: Story = {}
