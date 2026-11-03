import type { Meta, StoryObj } from '@storybook/vue3'
import { withSeed } from '~/stories/withStores'
import { useUiStore } from '~/stores/ui'
import IntegrationBackTitle from './IntegrationBackTitle.vue'

// The title of an integration panel's modal header. A Back button shows before the title only
// when the panel was opened from a hub, and its accessible name says which hub. Each story sets
// the ui store's hub flag the hub opener sets.
const meta = {
  title: 'Settings/Components/IntegrationBackTitle',
  component: IntegrationBackTitle,
  parameters: { width: 'panel' },
  args: { title: 'Issue trackers' },
} satisfies Meta<typeof IntegrationBackTitle>
export default meta

type Story = StoryObj<typeof meta>

/** Opened from the Integrations hub: Back, labelled for that hub. */
export const Default: Story = {
  decorators: [
    withSeed(() => {
      useUiStore().cameFromIntegrations = true
    }),
  ],
}

/** Opened from a sidebar link or a banner: the title alone, with no Back. */
export const NoHub: Story = {}

/** Opened from My setup: Back, labelled for that hub. */
export const FromPersonal: Story = {
  args: { title: 'Personal subscriptions' },
  decorators: [
    withSeed(() => {
      useUiStore().cameFromPersonal = true
    }),
  ],
}
