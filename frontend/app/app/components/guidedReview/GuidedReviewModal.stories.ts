import type { Meta, StoryObj } from '@storybook/vue3'
import type { GuidedReviewSessionView } from '@cat-factory/contracts'
import { getGuidedReviewContract, getGuidedReviewThreadContract } from '@cat-factory/contracts'
import type { HttpHandler } from 'msw'
import { screen } from 'storybook/test'
import { apiPending, apiResponse } from '~/stories/api'
import { storyWorkspacePrefix } from '~/stories/workspace'
import { githubLoadApi } from '~/stories/githubApi'
import {
  guidedReviewSession,
  guidedReviewThread,
  indexAnswer,
  indexQuestion,
  raceAnswer,
  raceQuestion,
} from '~/stories/guidedReview.stories.mocks'
import { authRepo, pullRequest } from '~/stories/vcs.stories.mocks'
import { seedWorkspace, withSeed } from '~/stories/withStores'
import { useGuidedReviewStore } from '~/stores/guidedReview'
import { useUiStore } from '~/stores/ui'
import GuidedReviewModal from './GuidedReviewModal.vue'

// A guided review of one pull request, full screen: the overview on the left, and the threads as
// tabs on the right, with a tab for a new question. Opened on a review, on a pull request, or on
// neither, which shows the picker. Opening it loads the GitHub store's repositories and pull
// requests, which say whether the pull request moved on since the review, and then the review and
// its first thread. The review and the thread are the shared ones (`guidedReview.stories.mocks.ts`).
const SESSION_ID = 'grs_auth_212'
const session = guidedReviewSession()
const raceThread = guidedReviewThread([raceQuestion, raceAnswer, indexQuestion, indexAnswer])

/** The review with the race thread, as the session read lists it. */
const withThread: GuidedReviewSessionView = {
  session,
  threads: [{ ...raceThread.thread, pendingMessageId: null }],
  drafts: [],
}

/** Pull request 212 at the commit the review read, or at a later one. */
function pulls(headSha = session.reviewedHeadSha): HttpHandler[] {
  return githubLoadApi({
    repos: [authRepo],
    pulls: [pullRequest(212, session.prTitle, { headSha })],
  })
}

function reads(view: GuidedReviewSessionView = withThread): HttpHandler[] {
  const pathPrefix = storyWorkspacePrefix
  return [
    apiResponse(getGuidedReviewContract, {
      pathPrefix,
      pathParams: { sessionId: SESSION_ID },
      body: view,
    }),
    apiResponse(getGuidedReviewThreadContract, {
      pathPrefix,
      pathParams: { sessionId: SESSION_ID, threadId: raceThread.thread.id },
      body: raceThread,
    }),
  ]
}

function opened(sessionId: string | null) {
  return withSeed(() => {
    seedWorkspace()
    useUiStore().openGuidedReview({ sessionId, target: null })
  })
}

const meta = {
  title: 'Review/Components/GuidedReviewModal',
  component: GuidedReviewModal,
  decorators: [opened(SESSION_ID)],
  parameters: { api: [...reads(), ...pulls()] },
} satisfies Meta<typeof GuidedReviewModal>
export default meta

type Story = StoryObj<typeof meta>

/** The overview, and the race thread open in its tab with two questions answered. */
export const Default: Story = {}

/** Opened on neither a review nor a pull request: the picker. */
export const Picker: Story = {
  decorators: [opened(null)],
}

/** The review has not loaded yet: placeholder blocks for the overview and the thread. */
export const Loading: Story = {
  parameters: {
    api: [
      apiPending(getGuidedReviewContract, {
        pathPrefix: storyWorkspacePrefix,
        pathParams: { sessionId: SESSION_ID },
      }),
      ...pulls(),
    ],
  },
}

/** The pull request has a newer commit than the one the overview read: the stale badge. */
export const Stale: Story = {
  parameters: {
    api: [...reads(), ...pulls('2b7d0e91c4a3f5e68d1b9c0a7e4f3d2c1b0a9e8f')],
  },
}

/**
 * A live update named this review, and the reload after it failed: the line above the overview
 * says what is shown may be out of date. The play records the failure on the store, as the
 * store's `follow` does.
 */
export const OutOfDate: Story = {
  play: async () => {
    // After the thread lands too: loading it clears the failure.
    await screen.findByText(raceQuestion.content, { selector: 'p' })
    useGuidedReviewStore().failedLoads[SESSION_ID] = {
      [`s:${SESSION_ID}`]: new Error('Failed to fetch'),
    }
    await screen.findByTestId('guided-review-out-of-date')
  },
}

/** A review with no thread yet: the new question tab is the only one. */
export const NewThread: Story = {
  parameters: { api: [...reads({ ...withThread, threads: [] }), ...pulls()] },
}
