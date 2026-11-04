import type { Meta, StoryObj } from '@storybook/vue3'
import {
  guidedReviewDraft,
  guidedReviewMessage,
  guidedReviewThread,
  indexAnswer,
  indexQuestion,
  raceAnswer,
  raceQuestion,
} from '~/stories/guidedReview.stories.mocks'
import GuidedReviewThread from './GuidedReviewThread.vue'

// One thread of a guided review: the questions and answers, the comment drafts the thread
// produced, and a composer. While the thread waits for an answer the composer is disabled; other
// threads are not affected. The thread and its drafts arrive as props, and the store is called
// only when the reviewer sends or posts, which these stories do not. A drafts request carries no
// text of its own, because the SPA sends no instructions (`requestDrafts` in orchestration). The
// questions and answers are made up.
const meta = {
  title: 'Review/Components/GuidedReviewThread',
  component: GuidedReviewThread,
  parameters: { width: 'prose' },
  args: { sessionId: 'grs_auth_212', view: undefined, drafts: [] },
} satisfies Meta<typeof GuidedReviewThread>
export default meta

type Story = StoryObj<typeof meta>

/** Two questions answered, each answer with the lines it cites. */
export const Default: Story = {
  args: { view: guidedReviewThread([raceQuestion, raceAnswer, indexQuestion, indexAnswer]) },
}

/** The new-thread tab: no thread yet, so its first question creates one. */
export const Empty: Story = {}

/** The first answer is queued: a spinner line, and the composer says the thread is busy. */
export const Waiting: Story = {
  args: {
    view: guidedReviewThread([
      raceQuestion,
      guidedReviewMessage(2, 'assistant', { status: 'pending', model: null }),
    ]),
  },
}

/**
 * The follow-up asked for a deep answer, which reads a checkout of the pull request: the
 * spinner line says the agent is investigating.
 */
export const Investigating: Story = {
  args: {
    view: guidedReviewThread([
      raceQuestion,
      raceAnswer,
      { ...indexQuestion, depth: 'deep' },
      guidedReviewMessage(4, 'assistant', { depth: 'deep', status: 'running', model: null }),
    ]),
  },
}

/**
 * The deep answer failed because the deployment cannot run an investigation. The backend sends
 * no detail for this reason, so there is no Details toggle, and the composer takes questions
 * again.
 */
export const Failed: Story = {
  args: {
    view: guidedReviewThread([
      raceQuestion,
      raceAnswer,
      { ...indexQuestion, depth: 'deep' },
      guidedReviewMessage(4, 'assistant', {
        depth: 'deep',
        status: 'failed',
        model: null,
        failure: { reason: 'depth_unavailable', detail: null },
      }),
    ]),
  },
}

const draftReport = {
  proposed: 3,
  dropped: [
    {
      path: 'src/sessions/refresh.test.ts',
      line: 12,
      side: 'RIGHT' as const,
      reason: 'not_in_pr' as const,
    },
  ],
}

/**
 * The reviewer asked for comments: of three proposed, two are kept as drafts and the third named
 * a file the pull request does not change. One draft is already posted, and nothing is ticked,
 * so the post button reads "Post 0" and is disabled. Each draft's rationale renders as Markdown,
 * so the code in the second one shows as a code span.
 */
export const WithDrafts: Story = {
  args: {
    view: guidedReviewThread([
      raceQuestion,
      raceAnswer,
      indexQuestion,
      indexAnswer,
      guidedReviewMessage(5, 'user', { kind: 'comment-drafts' }),
      guidedReviewMessage(6, 'assistant', { kind: 'comment-drafts', draftReport }),
    ]),
    drafts: [
      guidedReviewDraft(),
      guidedReviewDraft({
        id: 'grd_generation_index',
        path: 'migrations/0031_token_families.sql',
        line: 9,
        startLine: null,
        body:
          'Add a `generation` column and a unique index on `(family_id, generation)`, so a ' +
          'second refresh of one token fails at the insert.',
        rationale: 'The race in `refresh()` has no guard in the schema.',
        status: 'posted',
        postedUrl: 'https://github.com/acme/auth-service/pull/212#discussion_r1849302390',
        rev: 2,
      }),
    ],
  },
}
