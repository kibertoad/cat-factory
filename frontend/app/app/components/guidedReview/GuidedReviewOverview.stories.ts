import type { Meta, StoryObj } from '@storybook/vue3'
import { fn } from 'storybook/test'
import { guidedReviewSession } from '~/stories/guidedReview.stories.mocks'
import GuidedReviewOverview from './GuidedReviewOverview.vue'

// The overview a guided review writes for a pull request: a summary, the intent, the meaningful
// changes, their consequences, the risks by severity, where to look first, and questions to ask
// next. While it is written a spinner line shows; a failed one shows the translated reason. A
// suggested question opens a thread, and the chips wait while one opens. The content is made up
// (`guidedReview.stories.mocks.ts`).
const meta = {
  title: 'Review/Components/GuidedReviewOverview',
  component: GuidedReviewOverview,
  parameters: { width: 'prose' },
  args: {
    session: guidedReviewSession(),
    stale: false,
    refreshing: false,
    asking: false,
    onAsk: fn(),
    onRefresh: fn(),
  },
} satisfies Meta<typeof GuidedReviewOverview>
export default meta

type Story = StoryObj<typeof meta>

/** A finished overview with every section and two suggested questions. */
export const Default: Story = {}

/** Being written: the spinner line. */
export const Working: Story = {
  args: { session: guidedReviewSession({ status: 'running', content: null, model: null }) },
}

/** Writing failed: the translated reason, with the cause behind a disclosure. */
export const Failed: Story = {
  args: {
    session: guidedReviewSession({
      status: 'failed',
      content: null,
      model: null,
      failure: { reason: 'generation_failed', detail: 'Upstream model returned HTTP 529' },
    }),
  },
}

/** The pull request moved on since the overview was written: the stale badge. */
export const Stale: Story = { args: { stale: true } }

/** A suggested question is opening its thread: the chips are disabled. */
export const Asking: Story = { args: { asking: true } }
