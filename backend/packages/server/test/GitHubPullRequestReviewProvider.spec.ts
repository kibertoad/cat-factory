import type {
  BlockRepository,
  GitHubClient,
  GitHubPullRequestReview,
  GitHubReviewThread,
} from '@cat-factory/kernel'
import { describe, expect, it } from 'vitest'
import { GitHubPullRequestReviewProvider } from '../src/github/GitHubPullRequestReviewProvider.js'
import type { ResolveRepoTarget } from '../src/agents/ContainerAgentExecutor.js'

// Provider-level reduction of a PR's review event log into the snapshot the human-review gate
// classifies: approval count, the standing-change-requested flag, and the non-approving review
// SUMMARY bodies — driven over a hand-rolled GitHubClient so the reduction (sort by submittedAt,
// change-request detection, summary surfacing) is pinned independently of the transport.

const resolveRepoTarget: ResolveRepoTarget = async () => ({
  installationId: 1,
  owner: 'o',
  name: 'r',
  baseBranch: 'main',
})

const blockRepository = {
  get: async () => ({ pullRequest: { branch: 'feat', number: 7 } }),
} as unknown as BlockRepository

function provider(overrides: Partial<GitHubClient>): GitHubPullRequestReviewProvider {
  const githubClient = {
    branchHeadSha: async () => 'headsha',
    getRequiredApprovingReviewCount: async () => 1,
    getPullRequestBaseRef: async () => 'main',
    listPullRequestReviews: async () => [],
    listReviewThreads: async (): Promise<GitHubReviewThread[]> => [],
    listRequestedReviewers: async () => [],
    listIssueComments: async () => [],
    ...overrides,
  } as unknown as GitHubClient
  return new GitHubPullRequestReviewProvider({ githubClient, resolveRepoTarget, blockRepository })
}

function review(over: Partial<GitHubPullRequestReview>): GitHubPullRequestReview {
  return { author: 'alice', state: 'APPROVED', body: '', submittedAt: 0, commitId: null, ...over }
}

describe('GitHubPullRequestReviewProvider review reduction', () => {
  it('surfaces a CHANGES_REQUESTED review summary body as an actionable review-summary', async () => {
    const snap = await provider({
      listPullRequestReviews: async () => [
        review({
          author: 'alice',
          state: 'CHANGES_REQUESTED',
          body: 'Add error handling.',
          submittedAt: 10,
        }),
      ],
    }).getReview('w', 'b')
    expect(snap.approvals).toBe(0)
    expect(snap.changesRequested).toBe(true)
    expect(snap.reviewSummaries).toEqual([
      { id: 'review-1', author: 'alice', body: 'Add error handling.', createdAt: 10, isBot: false },
    ])
  })

  it('takes the LATEST standing review per author by submittedAt, regardless of array order', async () => {
    // An APPROVED (t=30) arriving in the array BEFORE the earlier CHANGES_REQUESTED (t=10) must not
    // fool the reduction: sorting by submittedAt makes the approval the latest standing state.
    const snap = await provider({
      listPullRequestReviews: async () => [
        review({ author: 'alice', state: 'APPROVED', submittedAt: 30 }),
        review({ author: 'alice', state: 'CHANGES_REQUESTED', body: 'nit', submittedAt: 10 }),
      ],
    }).getReview('w', 'b')
    expect(snap.approvals).toBe(1)
    expect(snap.changesRequested).toBe(false)
    // The earlier change-request's body is still recorded as a (cursor-gated) summary event.
    expect(snap.reviewSummaries.map((s) => s.body)).toEqual(['nit'])
  })

  it('reports changesRequested even when a different reviewer meets the required approvals', async () => {
    const snap = await provider({
      getRequiredApprovingReviewCount: async () => 1,
      listPullRequestReviews: async () => [
        review({ author: 'bob', state: 'APPROVED', submittedAt: 20 }),
        review({ author: 'alice', state: 'CHANGES_REQUESTED', submittedAt: 10 }),
      ],
    }).getReview('w', 'b')
    expect(snap.approvals).toBe(1)
    expect(snap.changesRequested).toBe(true)
  })

  it('excludes bot reviews from approvals, change-requests, and summaries', async () => {
    const snap = await provider({
      listPullRequestReviews: async () => [
        review({
          author: 'coderabbitai[bot]',
          state: 'CHANGES_REQUESTED',
          body: 'bot feedback',
          submittedAt: 5,
        }),
      ],
    }).getReview('w', 'b')
    expect(snap.approvals).toBe(0)
    expect(snap.changesRequested).toBe(false)
    expect(snap.reviewSummaries).toEqual([])
  })
})
