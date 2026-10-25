import type { Meta, StoryObj } from '@storybook/vue3'
import {
  listLocalModelEndpointsContract,
  listPersonalSubscriptionsContract,
  listUserSecretsContract,
} from '@cat-factory/contracts'
import { expect, screen } from 'storybook/test'
import { apiFailure, apiPending, apiResponse } from '~/stories/api'
import { localModelEndpoint, personalSubscription } from '~/stories/providers.stories.mocks'
import { withSeed } from '~/stories/withStores'
import { useUiStore } from '~/stores/ui'
import PersonalSetupModal from './PersonalSetupModal.vue'

// "My setup": the connections that belong to the signed-in user rather than the board, a
// personal GitHub token, the user's own subscriptions and local model runners, each opening its
// own window. The board mounts the modal only once it is open, and the modal loads its three
// stores as it mounts. The stores start empty here, so every badge comes from the answers the
// story gives those three requests.
const ROW_KEYS = ['github-pat', 'local-runners', 'personal-subs'] as const

function connectedAnswers() {
  return [
    apiResponse(listUserSecretsContract, {
      body: {
        secrets: [
          {
            kind: 'github_pat',
            label: 'Personal GitHub token',
            hasSecret: true,
            connectedAt: Date.UTC(2026, 8, 14),
          },
        ],
        descriptors: [],
      },
    }),
    apiResponse(listLocalModelEndpointsContract, { body: { endpoints: [localModelEndpoint()] } }),
    apiResponse(listPersonalSubscriptionsContract, {
      body: {
        subscriptions: [
          personalSubscription(),
          personalSubscription({
            vendor: 'codex',
            label: 'ChatGPT Pro',
            expiresAt: null,
            expiresInDays: null,
          }),
        ],
      },
    }),
  ]
}

const meta = {
  title: 'Settings/Components/PersonalSetupModal',
  component: PersonalSetupModal,
  decorators: [withSeed(() => useUiStore().openPersonalSetup())],
  parameters: { api: connectedAnswers() },
} satisfies Meta<typeof PersonalSetupModal>
export default meta

type Story = StoryObj<typeof meta>

/** A GitHub token, two subscriptions and one local runner, each marked connected once loaded. */
export const Default: Story = {
  play: async () => {
    for (const key of ROW_KEYS) await screen.findByTestId(`personal-setup-connected-${key}`)
  },
}

/** Nothing connected: every row says so. */
export const NothingConnected: Story = {
  parameters: {
    api: [
      apiResponse(listUserSecretsContract, { body: { secrets: [], descriptors: [] } }),
      apiResponse(listLocalModelEndpointsContract, { body: { endpoints: [] } }),
      apiResponse(listPersonalSubscriptionsContract, { body: { subscriptions: [] } }),
    ],
  },
}

/** The three reads are still in flight: each row says it is checking, not "Not connected". */
export const Checking: Story = {
  parameters: {
    api: [
      apiPending(listUserSecretsContract),
      apiPending(listLocalModelEndpointsContract),
      apiPending(listPersonalSubscriptionsContract),
    ],
  },
  play: async () => {
    await expect(await screen.findAllByText('Checking…')).toHaveLength(ROW_KEYS.length)
  },
}

/** All three loads fail: each row says it could not load, not that nothing is connected. */
export const LoadFailed: Story = {
  parameters: {
    api: [
      apiFailure(listUserSecretsContract),
      apiFailure(listLocalModelEndpointsContract),
      apiFailure(listPersonalSubscriptionsContract),
    ],
  },
  play: async () => {
    for (const key of ROW_KEYS) await screen.findByTestId(`personal-setup-failed-${key}`)
    await expect(screen.queryByTestId('personal-setup-connected-github-pat')).toBeNull()
  },
}
