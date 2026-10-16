import type { Meta, StoryObj } from '@storybook/vue3'
import { userEvent, within } from 'storybook/test'
import GuidedReviewFailure from './GuidedReviewFailure.vue'

// Why a guided-review overview or answer failed: a reason from a closed set, shown as translated
// copy, and the raw cause behind a "Details" toggle. With no detail there is no toggle.
const meta = {
  title: 'Review/Components/GuidedReviewFailure',
  component: GuidedReviewFailure,
  parameters: { width: 'panel' },
} satisfies Meta<typeof GuidedReviewFailure>
export default meta

type Story = StoryObj<typeof meta>

export const Default: Story = {
  args: {
    failure: {
      reason: 'generation_failed',
      detail: 'provider returned 503 after 3 retries (anthropic/claude-opus-5)',
    },
  },
}

/** No detail, so no toggle. */
export const WithoutDetail: Story = {
  args: { failure: { reason: 'budget_exhausted', detail: null } },
}

/** The PR moved past the reviewed commit. This copy is the one that tells the reader to refresh. */
export const HeadMoved: Story = {
  args: { failure: { reason: 'head_moved', detail: 'reviewed 4af0cd6, head is now b4b3e54' } },
}

/** A long detail, opened: it wraps inside the panel. */
export const LongDetail: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await userEvent.click(canvas.getByRole('button', { name: 'Details' }))
    await canvas.findByTestId('guided-review-failure-detail')
  },
  args: {
    failure: {
      reason: 'unreadable_reply',
      detail:
        'Expected a JSON object with `comments` and `rating`. Got:\n```\nI looked at the diff and I think it is fine overall, though I would\n```\n(reply truncated at 2048 characters)',
    },
  },
}
