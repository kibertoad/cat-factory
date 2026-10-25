import type { Meta, StoryObj } from '@storybook/vue3'
import {
  listLocalModelEndpointsContract,
  listPersonalSubscriptionsContract,
} from '@cat-factory/contracts'
import { userEvent, screen } from 'storybook/test'
import { apiFailure } from '~/stories/api'
import { apiKey, localModelEndpoint } from '~/stories/providers.stories.mocks'
import { providersApi } from '~/stories/providersApi'
import { seedWorkspace, withSeed } from '~/stories/withStores'
import { useUiStore } from '~/stores/ui'
import ModelProvidersHub from './ModelProvidersHub.vue'

// Where the engines that run the work are connected: OpenRouter and the vendor keys for the
// workspace, and each user's own subscriptions and local runners. A row says whether it is
// connected, connected rows first, and opens that provider's own window. With nothing connected,
// a callout says no agent step can run and OpenRouter is marked recommended. The hub reloads each
// provider's status when it opens, so each story answers those reads.
const meta = {
  title: 'Settings/Components/ModelProvidersHub',
  component: ModelProvidersHub,
  decorators: [
    withSeed(() => {
      seedWorkspace()
      useUiStore().openModelProviders()
    }),
  ],
  parameters: {
    api: providersApi({
      workspaceKeys: [apiKey()],
      endpoints: [
        localModelEndpoint(),
        localModelEndpoint({
          provider: 'lmstudio',
          label: 'LM Studio on the GPU box',
          baseUrl: 'http://10.0.4.20:1234',
        }),
      ],
    }),
  },
} satisfies Meta<typeof ModelProvidersHub>
export default meta

type Story = StoryObj<typeof meta>

/** An OpenRouter key and two local runners connected, each first in its group. */
export const Default: Story = {}

/** Nothing connected: the callout, and OpenRouter marked recommended. */
export const NothingConnected: Story = { parameters: { api: providersApi() } }

/**
 * The only OpenRouter key is disabled. The key contract says a disabled key does not make its
 * provider configured, but the row reads Key connected and there is no callout.
 */
export const DisabledKeyOnly: Story = {
  parameters: { api: providersApi({ workspaceKeys: [apiKey({ enabled: false })] }) },
}

/**
 * The two per-user reads fail: those rows say they could not load, not that nothing is connected.
 * The failures come first because the first matching answer wins.
 */
export const PersonalLoadFailed: Story = {
  parameters: {
    api: [
      apiFailure(listLocalModelEndpointsContract),
      apiFailure(listPersonalSubscriptionsContract),
      ...providersApi({ workspaceKeys: [apiKey()] }),
    ],
  },
  play: async () => {
    await screen.findByTestId('model-providers-failed-personal-subs')
    await screen.findByTestId('model-providers-failed-local-runners')
  },
}

/** A search that matches no provider. */
export const NoResults: Story = {
  play: async () => {
    await userEvent.type(await screen.findByPlaceholderText('Search providers…'), 'bedrock')
    await screen.findByText('No providers match "bedrock".')
  },
}
