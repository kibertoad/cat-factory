import type { Meta, StoryObj } from '@storybook/vue3'
import { expect, screen, userEvent, waitFor } from 'storybook/test'
import { adoptionPlan, awaitingReviewJob, surveyReads } from '~/stories/bootstrap.stories.mocks'
import AdoptionReviewModal from './AdoptionReviewModal.vue'

// The review a monorepo bootstrap waits on: for each area the survey found, the reviewer decides
// whether the new service follows the monorepo or keeps what the template ships. The modal opens
// itself on mount. Each choice starts on the recommendation, and the approve button waits until
// the reviewer has answered every line. Approving sends the review, which no story answers.
const meta = {
  title: 'Board/Components/AdoptionReviewModal',
  component: AdoptionReviewModal,
  args: { job: awaitingReviewJob() },
} satisfies Meta<typeof AdoptionReviewModal>
export default meta

type Story = StoryObj<typeof meta>

/**
 * Three decisions, none answered: each is marked as needing a decision, and the footer counts
 * them. The container decision cites only the template, because the monorepo has no image.
 */
export const Default: Story = {}

/** Accept all: every line is answered and Approve and build enables. */
export const AllAccepted: Story = {
  play: async () => {
    await userEvent.click(await screen.findByRole('button', { name: 'Accept all suggestions' }))
    const approve = await screen.findByRole('button', { name: 'Approve and build' })
    await waitFor(() => expect(approve).toBeEnabled())
  },
}

/**
 * Every read the survey made, with its outcome. The model's Dockerfile read found nothing, and
 * the survey refused to read an environment file.
 */
export const SurveyOpen: Story = {
  play: async () => {
    await userEvent.click(
      await screen.findByRole('button', { name: 'Show every read the survey made' }),
    )
    await screen.findAllByText('refused')
  },
}

/**
 * A survey that ran out of reads, and a record that dropped 12 of them: both warnings show above
 * the decisions.
 */
export const BudgetExhausted: Story = {
  args: {
    job: awaitingReviewJob({
      adoptionPlan: adoptionPlan({
        survey: {
          reads: surveyReads,
          siblingServices: ['services/payments', 'services/ledger'],
          exploration: {
            calls: 24,
            maxCalls: 24,
            chars: 41_900,
            maxChars: 54_000,
            exhausted: 'calls',
            recordsDropped: 12,
          },
        },
      }),
    }),
  },
}

/**
 * No model for the survey, so no suggestion: the reason, the backend's detail line, the seeded
 * reads the survey made before it stopped, and the notes field. Approve and build stays enabled,
 * because the notes are all the reviewer can give.
 */
export const Unavailable: Story = {
  args: {
    job: awaitingReviewJob({
      adoptionPlan: adoptionPlan({
        status: 'unavailable',
        unavailableReason: 'model_unavailable',
        unavailableDetail:
          'No model is configured for the adoption survey, so the platform has no suggestion ' +
          'to offer. The decisions are still yours to make.',
        survey: {
          reads: surveyReads.filter((read) => read.origin === 'seed'),
          siblingServices: ['services/payments', 'services/ledger'],
          exploration: {
            calls: 0,
            maxCalls: 24,
            chars: 3772,
            maxChars: 54_000,
            exhausted: null,
            recordsDropped: 0,
          },
        },
        decisions: [],
        model: null,
      }),
    }),
  },
}
