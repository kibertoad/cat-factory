import type { Meta, StoryObj } from '@storybook/vue3'
import { detectServiceProvisioningContract } from '@cat-factory/contracts'
import { screen, userEvent } from 'storybook/test'
import { apiResponse } from '~/stories/api'
import { storyWorkspacePrefix } from '~/stories/workspace'
import { authService, boardBlocks } from '~/stories/board.stories.mocks'
import { composeRecommendation } from '~/stories/composeSetup.stories.mocks'
import { seedBoard, seedVcs, seedWorkspace, withSeed } from '~/stories/withStores'
import { useUiStore } from '~/stores/ui'
import EnvironmentSetupWizard from './EnvironmentSetupWizard.vue'

// The Docker Compose setup wizard: a modal around the setup journey, with the step header above
// the current step. Opened from settings it starts at the service picker; opened from a service's
// inspector it starts at the review, for that service. The review step reads the service's
// repository when it first opens, so every story answers the detection with the shared
// recommendation. The step stories under Setup/Components show each step's own states.
function opened(frameId: string | null) {
  return withSeed(() => {
    seedWorkspace()
    seedBoard(boardBlocks)
    seedVcs()
    useUiStore().openEnvironmentSetup(frameId)
  })
}

const meta = {
  title: 'Setup/Components/EnvironmentSetupWizard',
  component: EnvironmentSetupWizard,
  decorators: [opened(null)],
  parameters: {
    api: [
      apiResponse(detectServiceProvisioningContract, {
        pathPrefix: storyWorkspacePrefix,
        body: composeRecommendation(),
      }),
    ],
  },
} satisfies Meta<typeof EnvironmentSetupWizard>
export default meta

type Story = StoryObj<typeof meta>

/** Opened from settings: four steps, the first the service picker. */
export const Default: Story = {}

/** The operator picked Auth Service: the second of four steps, with the detected recipe. */
export const ServicePicked: Story = {
  play: async () => {
    await userEvent.click(await screen.findByRole('button', { name: /Auth Service/ }))
    await screen.findByTestId('env-setup-step-review')
  },
}

/** Opened for Auth Service: three steps, the picker skipped, and the review first. */
export const ForService: Story = { decorators: [opened(authService.id)] }
