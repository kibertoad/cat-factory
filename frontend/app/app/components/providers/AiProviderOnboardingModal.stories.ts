import type { Meta, StoryObj } from '@storybook/vue3'
import { withSeed } from '~/stories/withStores'
import { useUiStore } from '~/stores/ui'
import AiProviderOnboardingModal from './AiProviderOnboardingModal.vue'

// The dialog the board opens once per session when the workspace has no usable model: it says
// why, and offers each way to add one. Each route closes the dialog and opens its own panel.
const meta = {
  title: 'Setup/Components/AiProviderOnboardingModal',
  component: AiProviderOnboardingModal,
  decorators: [withSeed(() => useUiStore().openAiProviderSetup())],
} satisfies Meta<typeof AiProviderOnboardingModal>
export default meta

type Story = StoryObj<typeof meta>

/** The no-model warning and the routes, a personal subscription first. */
export const Default: Story = {}
