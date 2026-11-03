import type { Meta, StoryObj } from '@storybook/vue3'
import { modelPreset } from '~/stories/policies.stories.mocks'
import { claudeOnlyCatalog } from '~/stories/providers.stories.mocks'
import { seedModelCatalog, withSeed } from '~/stories/withStores'
import { useModelPresetsStore } from '~/stores/modelPresets'
import AiProvidersBanner from './AiProvidersBanner.vue'

// The board's prompt that AI is not ready. With no model the workspace can run, it asks to
// configure AI; with models it can run but a default preset that assigns others, it shows a
// smaller warning. Both judge the workspace's model catalog once it has loaded. The default
// preset is the built-in one, all Kimi K2.7. Each button opens a dialog the board renders, not
// this banner.
const meta = {
  title: 'Setup/Components/AiProvidersBanner',
  component: AiProvidersBanner,
} satisfies Meta<typeof AiProvidersBanner>
export default meta

type Story = StoryObj<typeof meta>

/** Nothing connected: no model in the catalog can run. */
export const Default: Story = {
  decorators: [
    withSeed(() => {
      seedModelCatalog(claudeOnlyCatalog.map((m) => ({ ...m, available: false })))
      useModelPresetsStore().hydrate([modelPreset()])
    }),
  ],
}

/** Only the Claude subscription is connected, and the default preset still assigns Kimi K2.7. */
export const PresetMismatch: Story = {
  decorators: [
    withSeed(() => {
      seedModelCatalog(claudeOnlyCatalog)
      useModelPresetsStore().hydrate([modelPreset()])
    }),
  ],
}
