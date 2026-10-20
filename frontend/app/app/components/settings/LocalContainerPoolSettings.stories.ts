import { getLocalSettingsContract } from '@cat-factory/contracts'
import type { Meta, StoryObj } from '@storybook/vue3'
import { apiResponse } from '~/stories/api'
import { localSettings } from '~/stories/infra.stories.mocks'
import LocalContainerPoolSettings from './LocalContainerPoolSettings.vue'

// The warm container pool and checkout reuse of a local deployment, in the Infrastructure
// window's agent containers tab. The panel loads the stored settings on every mount, so the
// story answers that request. A save resizes the running pool without a restart.
const meta = {
  title: 'Settings/Components/LocalContainerPoolSettings',
  component: LocalContainerPoolSettings,
  parameters: {
    width: 'prose',
    api: [apiResponse(getLocalSettingsContract, { body: localSettings })],
  },
} satisfies Meta<typeof LocalContainerPoolSettings>
export default meta

type Story = StoryObj<typeof meta>

/** Two warm containers, one kept ready and four at most, and the default checkout settings. */
export const Default: Story = {}
