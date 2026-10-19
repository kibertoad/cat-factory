import type { Meta, StoryObj } from '@storybook/vue3'
import type { PendingCredential } from '~/stores/personalSubscriptions'
import { withSeed } from '~/stories/withStores'
import { usePersonalSubscriptionsStore } from '~/stores/personalSubscriptions'
import PersonalCredentialModal from './PersonalCredentialModal.vue'

// The prompt that opens when a run pinned to someone's own subscription needs their personal
// password to start: the server answered 428, and the run waits. A password resumes it. With no
// subscription, or an expired one, a password cannot help, so the modal offers to connect one.
// The pending prompt is seeded; Start and Connect act on the store and send nothing here.
function pendingFor(reason: PendingCredential['reason']) {
  return withSeed(() => {
    usePersonalSubscriptionsStore().pending = {
      vendor: 'claude',
      reason,
      retry: async () => {},
      cancel: () => {},
    }
  })
}

const meta = {
  title: 'Pipeline/Components/PersonalCredentialModal',
  component: PersonalCredentialModal,
  decorators: [pendingFor('password_required')],
} satisfies Meta<typeof PersonalCredentialModal>
export default meta

type Story = StoryObj<typeof meta>

/** The password field; Start stays off until six characters. */
export const Default: Story = {}

/** The last password was wrong: the title says so. */
export const WrongPassword: Story = { decorators: [pendingFor('wrong_password')] }

/** No Claude subscription connected: connect one instead. */
export const NoSubscription: Story = { decorators: [pendingFor('no_subscription')] }

/** The Claude subscription expired: connect it again. */
export const Expired: Story = { decorators: [pendingFor('subscription_expired')] }
