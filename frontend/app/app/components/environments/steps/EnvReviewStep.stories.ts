import type { Meta, StoryObj } from '@storybook/vue3'
import type { ExecutionInstance, ProvisioningRecommendation } from '@cat-factory/contracts'
import { detectServiceProvisioningContract, mergeAnalystRecipeDraft } from '@cat-factory/contracts'
import { userEvent, within } from 'storybook/test'
import { apiRefusal } from '~/stories/api'
import { storyWorkspacePrefix } from '~/stories/workspace'
import { authService } from '~/stories/board.stories.mocks'
import {
  analystRun,
  composeRecommendation,
  composeRecommendationWithCli,
} from '~/stories/composeSetup.stories.mocks'
import { snapshot } from '~/stories/snapshot.stories.mocks'
import { seedSnapshot, seedVcs, withSeed } from '~/stories/withStores'
import { useEnvironmentWizardStore } from '~/stores/environmentWizard'
import EnvReviewStep from './EnvReviewStep.vue'

// The wizard step where the operator checks the Docker Compose recipe the detector read from the
// service's repository: which compose service to expose and on which port, which compose files to
// layer, which profiles to turn on, which seed dumps to import, and where each field came from.
// Deep analysis starts the environment analyst, whose draft fills what the detector cannot read.
// Next stays off until there is a recommendation and a service.
//
// The step points the wizard store at its frame on mount, and a new frame resets the store and
// starts the detection. So the seed sets the frame first and the detection's result after it, as
// `detect()` would. The working recipe is the detector's alone, as `detect()` seeds it: the
// analyst's draft joins it only when the operator applies it.
function onFrame(
  state: {
    recommendation?: ProvisioningRecommendation | null
    detectError?: boolean
    linked?: boolean
    runs?: ExecutionInstance[]
  } = {},
) {
  return withSeed(() => {
    seedSnapshot(snapshot({ executions: state.runs ?? [] }))
    if (state.linked !== false) seedVcs()
    const wizard = useEnvironmentWizardStore()
    wizard.frameId = authService.id
    const recommendation =
      state.recommendation === undefined ? composeRecommendation() : state.recommendation
    wizard.recommendation = recommendation
    wizard.detectError = state.detectError ?? false
    if (recommendation) {
      wizard.recipe = mergeAnalystRecipeDraft(recommendation).recipe
      wizard.composeService =
        recommendation.composeServiceCandidates?.find((c) => c.recommended)?.service ?? ''
    }
  })
}

const meta = {
  title: 'Setup/Components/EnvReviewStep',
  component: EnvReviewStep,
  args: { input: { frameId: authService.id }, exit: () => {}, goBack: () => {} },
  parameters: { width: 'prose' },
  decorators: [onFrame()],
} satisfies Meta<typeof EnvReviewStep>
export default meta

type Story = StoryObj<typeof meta>

/**
 * The detector's recipe: `auth` exposed, the base file and its override layered, the macOS and
 * WSL overrides and the observability profile offered, and one seed dump to import.
 */
export const Default: Story = {}

/** The service has no linked repository: Re-detect is off, and the step says why. */
export const NoRepo: Story = { decorators: [onFrame({ recommendation: null, linked: false })] }

/** Detection failed: the step's own message, and Next stays off. */
export const Error: Story = {
  decorators: [onFrame({ recommendation: null })],
  parameters: {
    api: [
      apiRefusal(detectServiceProvisioningContract, {
        pathPrefix: storyWorkspacePrefix,
        status: 422,
        error: {
          code: 'validation',
          message:
            'Could not read acme/auth-service to auto-detect. Confirm the GitHub App still has ' +
            '"Contents: read" access to this repository (re-check the installation\'s repository ' +
            'access), that the branch exists, and that you are not rate-limited, then retry. ' +
            'Underlying error: Not Found',
        },
      }),
    ],
  },
  play: async ({ canvasElement }) => {
    await userEvent.click(within(canvasElement).getByTestId('env-setup-detect'))
  },
}

/** The repository has its own bring-up script: the deep analysis box asks for a run. */
export const CliNudge: Story = {
  decorators: [onFrame({ recommendation: composeRecommendationWithCli() })],
}

/**
 * The analyst's run is done: its summary and Apply, and the provenance shows the fields it added
 * beside the detector's.
 */
export const AnalysisReady: Story = {
  decorators: [onFrame({ recommendation: composeRecommendationWithCli(), runs: [analystRun()] })],
}

/** The analyst's run failed. */
export const AnalysisFailed: Story = {
  decorators: [
    onFrame({
      recommendation: composeRecommendationWithCli(),
      runs: [analystRun({ status: 'failed', steps: [] })],
    }),
  ],
}

/** The raw recipe editor, open on the working recipe as JSON. */
export const RawEditor: Story = {
  play: async ({ canvasElement }) => {
    await userEvent.click(within(canvasElement).getByTestId('env-setup-raw-toggle'))
  },
}

/** A raw edit the recipe schema refuses: an empty compose file list. The error is the schema's. */
export const RawEditorInvalid: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await userEvent.click(canvas.getByTestId('env-setup-raw-toggle'))
    // Nuxt UI puts the test id on the textarea itself.
    const text = canvas.getByTestId('env-setup-raw-text')
    await userEvent.clear(text)
    await userEvent.type(text, '{{"composeFiles": [[]}')
    await userEvent.click(canvas.getByTestId('env-setup-raw-apply'))
  },
}
