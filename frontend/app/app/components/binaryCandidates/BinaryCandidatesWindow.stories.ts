import type { Meta, StoryObj } from '@storybook/vue3'
import type { BinaryCandidateStepState } from '@cat-factory/contracts'
import { getBinaryCandidatesContract } from '@cat-factory/contracts'
import type { HttpHandler } from 'msw'
import { screen, userEvent } from 'storybook/test'
import { apiFailure, apiPending, apiResponse, artifactBlobResponse } from '~/stories/api'
import { storyWorkspacePrefix } from '~/stories/workspace'
import { referencePng, screenshotPng } from '~/stories/artifact.stories.mocks'
import {
  BOLD_HERO,
  CALM_HERO,
  candidateState,
  heroCandidates,
} from '~/stories/binaryCandidates.stories.mocks'
import { step } from '~/stories/pipelineStep.stories.mocks'
import { execution, snapshot } from '~/stories/snapshot.stories.mocks'
import { seedResultView, seedSnapshot, withSeed } from '~/stories/withStores'
import BinaryCandidatesWindow from './BinaryCandidatesWindow.vue'

// A step generated several candidates for one asset, and a person keeps one (or several, each
// under its own id) before the step stores it. Candidates are grouped by what they depict; a
// candidate whose store issues no link says its preview is unavailable rather than going
// missing. After the choice the window stays as the record, and an automatic keep says nobody
// looked. The state rides on the run's step, and opening the window reads it again, so each
// story seeds the run and answers the read with the same state. The candidates are the shared
// ones (`binaryCandidates.stories.mocks.ts`).
const RUN = 'exec_login'
const params = { pathPrefix: storyWorkspacePrefix, pathParams: { executionId: RUN } }

function opened(state: BinaryCandidateStepState | null, { run = true } = {}) {
  const instance = execution({
    steps: [
      step({ agentKind: 'coder', state: 'done', progress: 1 }),
      step({
        agentKind: 'media-generator',
        state: state?.status === 'awaiting_choice' ? 'working' : 'done',
        progress: state?.status === 'awaiting_choice' ? 0.5 : 1,
        ...(state ? { binaryCandidates: state } : {}),
      }),
    ],
    currentStep: 1,
  })
  return withSeed(() => {
    seedSnapshot(snapshot({ executions: [instance] }))
    seedResultView({
      view: 'binary-candidates',
      blockId: instance.blockId,
      instanceId: run ? instance.id : null,
      stepIndex: run ? 1 : null,
    })
  })
}

function answers(state: BinaryCandidateStepState | null): HttpHandler[] {
  return [
    apiResponse(getBinaryCandidatesContract, { ...params, body: state }),
    artifactBlobResponse(screenshotPng, { artifactId: CALM_HERO }),
    artifactBlobResponse(referencePng, { artifactId: BOLD_HERO }),
  ]
}

const meta = {
  title: 'Review/Components/BinaryCandidatesWindow',
  component: BinaryCandidatesWindow,
} satisfies Meta<typeof BinaryCandidatesWindow>
export default meta

type Story = StoryObj<typeof meta>

const waiting = candidateState()

/**
 * Three candidates for the sign-in illustration, the first ticked: two with a preview, and one
 * from the private store without. A note box, and Keep.
 */
export const Default: Story = {
  decorators: [opened(waiting)],
  parameters: { api: answers(waiting) },
}

const multi = candidateState({ multiSelect: true })

/**
 * Several may be kept, and Bold is ticked beside Calm: each asks for the id it is stored under,
 * and Keep waits until both have one.
 */
export const MultiSelect: Story = {
  decorators: [opened(multi)],
  parameters: { api: answers(multi) },
  play: async () => {
    await userEvent.click(await screen.findByRole('checkbox', { name: 'Bold' }))
    await screen.findByTestId('binary-candidates-missing-alias')
  },
}

const kept = candidateState({
  status: 'chosen',
  choice: {
    kept: [{ candidateId: 'cand_calm' }],
    discarded: ['cand_bold', 'cand_flat'],
    note: 'The bold one fights the form for attention.',
    at: Date.UTC(2026, 9, 13, 14, 0),
  },
})

/** Decided: the record marks the kept candidate, and nothing can be changed. */
export const Kept: Story = {
  decorators: [opened(kept)],
  parameters: { api: answers(kept) },
}

const automatic = candidateState({
  status: 'chosen',
  candidates: [heroCandidates[0]!],
  choice: {
    kept: [{ candidateId: 'cand_calm' }],
    discarded: [],
    automatic: true,
    at: Date.UTC(2026, 9, 13, 14, 0),
  },
})

/** Only one candidate came back, so the engine kept it: the window says nobody reviewed it. */
export const Automatic: Story = {
  decorators: [opened(automatic)],
  parameters: { api: answers(automatic) },
}

const noChoice = candidateState({
  status: 'no_choice',
  candidates: [],
  noChoiceReason: 'undeclared',
})

/** The agent's reply declared no candidates, so the step went on without a comparison. */
export const NoChoice: Story = {
  decorators: [opened(noChoice)],
  parameters: { api: answers(noChoice) },
}

const warned = candidateState({ invalidEntries: 1, omitted: 2, unusablePreviews: 1 })

/** The comparison is over fewer candidates than were declared: each loss on its own line. */
export const Warnings: Story = {
  decorators: [opened(warned)],
  parameters: { api: answers(warned) },
}

/** The step carries no state yet and the read has not answered. */
export const Loading: Story = {
  decorators: [opened(null)],
  parameters: { api: [apiPending(getBinaryCandidatesContract, params)] },
}

/** The read failed: the error, and Retry. */
export const Error: Story = {
  decorators: [opened(null)],
  parameters: { api: [apiFailure(getBinaryCandidatesContract, params)] },
}

/** Opened with no run to read from. */
export const NoRun: Story = {
  decorators: [opened(null, { run: false })],
}
