import type { PrReviewStatus } from '@cat-factory/contracts'
import type { Meta, StoryObj } from '@storybook/vue3'
import { prReview, step, subtasks } from '~/stories/pipelineStep.stories.mocks'
import PrReviewPhaseBadge from './PrReviewPhaseBadge.vue'

// The phase of a live pr-reviewer step on the board's task card and focus timeline. Six phases;
// `awaiting` is the only one that does not spin. `planning` and `reviewing` share the `reviewing`
// status and differ by whether a slice plan exists, so the fixture passes subtasks. A step with no
// live review renders nothing.
const meta = {
  title: 'Board/Components/PrReviewPhaseBadge',
  component: PrReviewPhaseBadge,
} satisfies Meta<typeof PrReviewPhaseBadge>
export default meta

type Story = StoryObj<typeof meta>

const reviewing = (status: PrReviewStatus, done = 0, total = 0) =>
  step({
    agentKind: 'pr-reviewer',
    prReview: prReview(status),
    subtasks: subtasks(done, total),
  })

/** Reading the diff, with a plan: 3 of 7 slices done. */
export const Default: Story = { args: { step: reviewing('reviewing', 3, 7) } }

/** Same status, no slice plan yet: no counts. */
export const Planning: Story = { args: { step: reviewing('reviewing') } }

/** Findings are ready for a human: a steady icon in the warning colour. */
export const Awaiting: Story = { args: { step: reviewing('awaiting_selection', 7, 7) } }

/** A finding is being investigated. */
export const Challenging: Story = { args: { step: reviewing('challenging', 7, 7) } }

export const Fixing: Story = { args: { step: reviewing('fixing', 7, 7) } }

export const Posting: Story = { args: { step: reviewing('posting', 7, 7) } }

/**
 * The run failed mid-review: a red cross, no spin, the whole badge in the error colour. The label
 * is unchanged, so it still reads "Reviewing 3/7 slices".
 */
export const RunFailed: Story = {
  args: { step: reviewing('reviewing', 3, 7), runFailed: true },
}
