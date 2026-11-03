import type { Meta, StoryObj } from '@storybook/vue3'
import { providerProbeApi } from '~/stories/setupApi'
import { seedWorkspace, withSeed } from '~/stories/withStores'
import { useWorkspaceStore } from '~/stores/workspace'
import ProviderConfigBanner from './ProviderConfigBanner.vue'

// The board's prompt that an infrastructure provider is set up for the deployment, but the
// workspace has not given it a value it requires, such as its API token. It asks both providers
// (test environments and the runner pool) to describe themselves once the board is ready, so
// each story answers those four reads (`providerProbeApi`). A provider that still misses a
// required value gets a button that opens its connect panel, which the board renders. Only
// someone who may change the workspace's connections sees it.
const meta = {
  title: 'Setup/Components/ProviderConfigBanner',
  component: ProviderConfigBanner,
  parameters: { api: providerProbeApi({ environmentMissing: ['apiToken'] }) },
  decorators: [
    withSeed(() => {
      seedWorkspace()
      useWorkspaceStore().ready = true
    }),
  ],
} satisfies Meta<typeof ProviderConfigBanner>
export default meta

type Story = StoryObj<typeof meta>

/** The test environment provider has no API token yet; the runner pool is complete. */
export const Default: Story = {}

/** Both providers miss their token: one title for both, and a button for each. */
export const BothKinds: Story = {
  parameters: {
    api: providerProbeApi({ environmentMissing: ['apiToken'], runnerMissing: ['apiToken'] }),
  },
}
