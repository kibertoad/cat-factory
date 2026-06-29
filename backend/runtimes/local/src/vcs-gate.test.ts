import { describe, expect, it } from 'vitest'
import type { BlockRepository } from '@cat-factory/kernel'
import { asGitHubClient } from '@cat-factory/gitlab'
import { FakeVcsClient } from '@cat-factory/conformance'
import {
  GitHubBranchUpdater,
  GitHubCiStatusProvider,
  GitHubPullRequestMerger,
  GitHubPullRequestReviewProvider,
  type ResolveRepoTarget,
} from '@cat-factory/server'

// ---------------------------------------------------------------------------
// Lock for the GitLab facade-parity fix: the engine's gate / merge / branch-update providers
// consume the legacy `GitHubClient` port, and a GitLab deployment satisfies them through
// `asGitHubClient(VcsClient)`. This drives the REAL providers over a GitLab-shaped client
// (`asGitHubClient(FakeVcsClient)`) and asserts the SAME normalised outcomes a GitHub-App client
// produces — and, crucially, that the branch-update takes GitLab's MR-rebase path rather than the
// `mergeBranch` GitLab does not support. If a future change stops the GitLab adapter from
// satisfying a gate seam, this fails instead of silently degrading a GitLab deployment's gate.
// ---------------------------------------------------------------------------

const resolveRepoTarget: ResolveRepoTarget = async () => ({
  installationId: 1,
  owner: 'o',
  name: 'r',
  baseBranch: 'main',
})

/** A block with an open PR — the only `BlockRepository` method these providers call is `get`. */
function blockRepo(): BlockRepository {
  return {
    get: async () => ({ pullRequest: { branch: 'feat', number: 7 } }),
  } as unknown as BlockRepository
}

describe('GitLab-backed engine VCS client drives the gate / merge / branch-update seams', () => {
  const gh = (vcs: FakeVcsClient) => asGitHubClient({ vcs, provider: 'gitlab' })
  const deps = (vcs: FakeVcsClient) => ({
    githubClient: gh(vcs),
    resolveRepoTarget,
    blockRepository: blockRepo(),
  })

  it('reads green CI for the `ci` gate', async () => {
    const report = await new GitHubCiStatusProvider(deps(new FakeVcsClient())).getStatus('w', 'b')
    expect(report.headSha).toBe('headsha')
    expect(report.checks).toEqual([
      { name: 'build', status: 'completed', conclusion: 'success', url: null },
    ])
  })

  it('reads an approved PR for the human-review gate', async () => {
    const snapshot = await new GitHubPullRequestReviewProvider(deps(new FakeVcsClient())).getReview(
      'w',
      'b',
    )
    expect(snapshot).toMatchObject({
      headSha: 'headsha',
      requiredApprovingReviewCount: 1,
      approvals: 1,
      unresolvedThreads: [],
    })
  })

  it('updates the PR branch via the MR rebase path (GitLab has no mergeBranch)', async () => {
    const vcs = new FakeVcsClient()
    const outcome = await new GitHubBranchUpdater(deps(vcs)).updateFromBase('w', 'b')
    expect(outcome).toBe('merged')
    // The branch was advanced by REBASING MR !7 — not by mergeBranch (which GitLab rejects).
    expect(vcs.calls.rebased).toEqual([7])
  })

  it('surfaces a rebase conflict so the conflicts gate escalates', async () => {
    const vcs = new FakeVcsClient({ rebaseOutcome: 'conflict' })
    expect(await new GitHubBranchUpdater(deps(vcs)).updateFromBase('w', 'b')).toBe('conflict')
  })

  it('merges the PR for real via the merger', async () => {
    const vcs = new FakeVcsClient()
    await new GitHubPullRequestMerger(deps(vcs)).mergeForBlock('w', 'b')
    expect(vcs.calls.merged).toEqual([7])
  })
})
