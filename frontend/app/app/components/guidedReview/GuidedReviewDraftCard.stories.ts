import type { Meta, StoryObj } from '@storybook/vue3'
import { fn, userEvent, within } from 'storybook/test'
import { guidedReviewDraft as draft } from '~/stories/guidedReview.stories.mocks'
import GuidedReviewDraftCard from './GuidedReviewDraftCard.vue'

// One review comment a guided review proposed for a pull request: where it anchors, its status,
// the comment and why it was proposed. A proposed or failed draft can be edited or discarded,
// and a postable one has a checkbox to include it in the next post. The draft is the shared
// guided review fixture.
const meta = {
  title: 'Review/Components/GuidedReviewDraftCard',
  component: GuidedReviewDraftCard,
  parameters: { width: 'prose' },
  args: {
    sessionId: 'grs_auth_212',
    draft: draft(),
    selected: false,
    postable: true,
    'onUpdate:selected': fn(),
  },
} satisfies Meta<typeof GuidedReviewDraftCard>
export default meta

type Story = StoryObj<typeof meta>

/** Proposed and postable: the checkbox, the comment, why, and Edit and Discard. */
export const Default: Story = {}

/** The same draft, ticked for the next post. */
export const Selected: Story = { args: { selected: true } }

/** Edit opened: the comment, its line and its side. */
export const Editing: Story = {
  play: async ({ canvasElement }) => {
    await userEvent.click(within(canvasElement).getByRole('button', { name: /edit/i }))
  },
}

/** Posted: no checkbox and no actions. */
export const Posted: Story = {
  args: {
    postable: false,
    draft: draft({
      status: 'posted',
      postedUrl: 'https://github.com/acme/auth-service/pull/212#discussion_r1849302211',
    }),
  },
}

/** The host refused the comment: its error, and the actions back. */
export const Failed: Story = {
  args: {
    draft: draft({
      status: 'failed',
      postError: 'Validation Failed: pull_request_review_thread.line must be part of the diff',
      rev: 2,
    }),
  },
}

/** Discarded: dimmed, with no actions. */
export const Discarded: Story = {
  args: { postable: false, draft: draft({ status: 'discarded', rev: 2 }) },
}
