import type { Meta, StoryObj } from '@storybook/vue3'
import { localModelEndpoint, personalSubscription } from '~/stories/providers.stories.mocks'
import { withSeed } from '~/stories/withStores'
import { useLocalModelsStore } from '~/stores/localModels'
import { usePersonalSubscriptionsStore } from '~/stores/personalSubscriptions'
import { useUiStore } from '~/stores/ui'
import { useUserSecretsStore } from '~/stores/userSecrets'
import PersonalSetupModal from './PersonalSetupModal.vue'

// "My setup": the connections that belong to the signed-in user rather than the board, a
// personal GitHub token, the user's own subscriptions and local model runners, each opening its
// own window. The board mounts the modal only once it is open, and its reload watch is not
// immediate, so opening it loads nothing: the rows show what other surfaces loaded into the
// stores. The stories seed those stores and answer no request.
function seeded(connected: boolean) {
  return withSeed(() => {
    useUserSecretsStore().secrets = connected
      ? [
          {
            kind: 'github_pat',
            label: 'Personal GitHub token',
            hasSecret: true,
            connectedAt: Date.UTC(2026, 8, 14),
          },
        ]
      : []
    useLocalModelsStore().endpoints = connected ? [localModelEndpoint()] : []
    usePersonalSubscriptionsStore().subscriptions = connected
      ? [
          personalSubscription(),
          personalSubscription({
            vendor: 'codex',
            label: 'ChatGPT Pro',
            expiresAt: null,
            expiresInDays: null,
          }),
        ]
      : []
    useUiStore().openPersonalSetup()
  })
}

const meta = {
  title: 'Settings/Components/PersonalSetupModal',
  component: PersonalSetupModal,
  decorators: [seeded(true)],
} satisfies Meta<typeof PersonalSetupModal>
export default meta

type Story = StoryObj<typeof meta>

/** A GitHub token, two subscriptions and one local runner, each marked connected. */
export const Default: Story = {}

/** Nothing connected: every row says so. */
export const NothingConnected: Story = { decorators: [seeded(false)] }
