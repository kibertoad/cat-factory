import type { Meta, StoryObj } from '@storybook/vue3'
import type { ProvisioningLogEntry } from '@cat-factory/contracts'
import {
  listProvisioningLogsContract,
  registerEnvironmentHandlerContract,
} from '@cat-factory/contracts'
import { userEvent, within } from 'storybook/test'
import { apiFailure, apiResponse } from '~/stories/api'
import { STORY_WORKSPACE_ID, storyWorkspacePrefix } from '~/stories/workspace'
import { authService, boardBlocks } from '~/stories/board.stories.mocks'
import { seedBoard, seedWorkspace, withSeed } from '~/stories/withStores'
import { useEnvironmentWizardStore } from '~/stores/environmentWizard'
import EnvSaveStep from './EnvSaveStep.vue'

// The last step of the environment setup wizard: name the Docker Compose handler and save. Save
// registers the handler for the workspace and writes the recipe onto the service frame. After
// that, a trial provision can start the environment once, with its logs below. Done ends the
// wizard; here it does nothing.
//
// The step points the wizard store at its frame on mount, and a new frame resets the store and
// starts the repo detection. So the seed sets the frame first and the step's state after it. The
// compose service the operator picked earlier is `auth`.
function onFrame(state: { saved?: boolean; trialStarted?: boolean } = {}) {
  return withSeed(() => {
    seedWorkspace()
    seedBoard(boardBlocks)
    const wizard = useEnvironmentWizardStore()
    wizard.frameId = authService.id
    wizard.composeService = 'auth'
    wizard.saved = state.saved ?? false
    wizard.trialStarted = state.trialStarted ?? false
  })
}

/** The trial's one attempt so far: the Compose stack started for Auth Service. Made up. */
const trialAttempt: ProvisioningLogEntry = {
  id: 'pe_trial',
  workspaceId: STORY_WORKSPACE_ID,
  subsystem: 'environment',
  operation: 'provision',
  targetId: 'env_auth_trial',
  providerId: 'compose',
  blockId: authService.id,
  executionId: null,
  outcome: 'success',
  error: null,
  detail: null,
  createdAt: Date.UTC(2026, 9, 11, 10, 4),
}

const meta = {
  title: 'Setup/Components/EnvSaveStep',
  component: EnvSaveStep,
  args: { input: { frameId: authService.id }, exit: () => {}, goBack: () => {} },
  parameters: { width: 'prose' },
  decorators: [onFrame()],
} satisfies Meta<typeof EnvSaveStep>
export default meta

type Story = StoryObj<typeof meta>

/** Not saved yet: the handler name, what Save will do, and Save. */
export const Default: Story = {}

/** Save failed: the step shows the backend's message as it came, and Save stays. */
export const Error: Story = {
  parameters: {
    api: [apiFailure(registerEnvironmentHandlerContract, { pathPrefix: storyWorkspacePrefix })],
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await userEvent.click(canvas.getByTestId('env-setup-save'))
    await canvas.findByTestId('env-setup-save-error')
  },
}

/** Saved: the confirmation, and the trial provision offer. */
export const Saved: Story = { decorators: [onFrame({ saved: true })] }

/** The trial started: its button disables, and the environment's attempts show below. */
export const TrialStarted: Story = {
  decorators: [onFrame({ saved: true, trialStarted: true })],
  parameters: {
    api: [
      apiResponse(listProvisioningLogsContract, {
        pathPrefix: storyWorkspacePrefix,
        body: { entries: [trialAttempt] },
      }),
    ],
  },
}
