import { describe, expect, it, vi } from 'vitest'
import type { Block, GitHubClient } from '@cat-factory/kernel'
import { GitHubCiStatusProvider } from '../src/github/GitHubCiStatusProvider.js'
import { GitHubMergeabilityProvider } from '../src/github/GitHubMergeabilityProvider.js'
import { GitHubPullRequestMerger } from '../src/github/GitHubPullRequestMerger.js'

// Service-connections phase 4: the CI / mergeability / merger gate providers fan out across
// EVERY PR a multi-repo task opened (own-service + peer-service repos). These pin the per-PR
// resolution + the merge-all ordering/partial behaviour that only the assembled GitHub client
// can exercise (the cross-runtime CI aggregation is covered by the conformance suite).

const OWN_TARGET = {
  installationId: 42,
  owner: 'o',
  name: 'own',
  baseBranch: 'main',
}

/** A multi-repo task block: own-service PR + one peer-service PR. */
const MULTI_BLOCK = {
  id: 'task_login',
  pullRequest: { url: 'https://github.com/o/own/pull/1', number: 1, branch: 'cat-factory/login' },
  peerPullRequests: [
    {
      repo: 'o/email',
      frameId: 'frm_email',
      ref: { url: 'https://github.com/o/email/pull/7', number: 7, branch: 'cat-factory/login' },
    },
  ],
} as unknown as Block

const paged = <T>(items: T[]) => ({ items, hasMore: false, cursor: null }) as any

describe('GitHubCiStatusProvider (multi-repo)', () => {
  it('reports per-PR checks across own + peer repos under the own installation', async () => {
    const listCommits = vi.fn(async (_i: number, ref: { owner: string; repo: string }) =>
      paged([{ sha: `${ref.repo}-sha` }]),
    )
    const listCheckRuns = vi.fn(async (_i: number, ref: { owner: string; repo: string }) =>
      paged([
        {
          name: `${ref.repo}-build`,
          status: 'completed',
          conclusion: ref.repo === 'email' ? 'failure' : 'success',
          htmlUrl: null,
        },
      ]),
    )
    const provider = new GitHubCiStatusProvider({
      githubClient: { listCommits, listCheckRuns } as unknown as GitHubClient,
      resolveRepoTarget: async () => OWN_TARGET,
      blockRepository: { get: async () => MULTI_BLOCK } as any,
    })

    const report = await provider.getStatus('ws', 'task_login')
    expect(report.repos.map((r) => r.repo)).toEqual(['o/own', 'o/email'])
    expect(report.repos[0]).toMatchObject({ headSha: 'own-sha' })
    expect(report.repos[1]).toMatchObject({ headSha: 'email-sha' })
    expect(report.repos[1]!.checks[0]).toMatchObject({ name: 'email-build', conclusion: 'failure' })
    // Every PR is read under the own repo's installation id (one installation per workspace).
    expect(listCommits).toHaveBeenCalledTimes(2)
    expect(listCheckRuns.mock.calls.every((c) => c[0] === 42)).toBe(true)
  })
})

describe('GitHubMergeabilityProvider (multi-repo)', () => {
  it('reports per-PR mergeability, tagging the conflicted peer with its frame id', async () => {
    const getPullRequestMergeability = vi.fn(
      async (_i: number, ref: { owner: string; repo: string }) =>
        ref.repo === 'email'
          ? { mergeable: false, mergeableState: 'dirty', headSha: 'email-sha' }
          : { mergeable: true, mergeableState: 'clean', headSha: 'own-sha' },
    )
    const provider = new GitHubMergeabilityProvider({
      githubClient: { getPullRequestMergeability } as unknown as GitHubClient,
      resolveRepoTarget: async () => OWN_TARGET,
      blockRepository: { get: async () => MULTI_BLOCK } as any,
    })

    const report = await provider.getMergeability('ws', 'task_login')
    expect(report.repos).toEqual([
      { repo: 'o/own', headSha: 'own-sha', verdict: 'mergeable' },
      { repo: 'o/email', frameId: 'frm_email', headSha: 'email-sha', verdict: 'conflicted' },
    ])
  })
})

describe('GitHubPullRequestMerger (multi-repo merge-all)', () => {
  it('merges every PR in order and deletes each work branch', async () => {
    const mergePullRequest = vi.fn(
      async (_i: number, _ref: { owner: string; repo: string }, _n: number) => {},
    )
    const deleteBranch = vi.fn(async () => {})
    const merger = new GitHubPullRequestMerger({
      githubClient: { mergePullRequest, deleteBranch } as unknown as GitHubClient,
      resolveRepoTarget: async () => OWN_TARGET,
      blockRepository: { get: async () => MULTI_BLOCK } as any,
    })
    const outcome = await merger.mergePullRequests('ws', 'task_login', [
      {
        repo: 'o/email',
        frameId: 'frm_email',
        ref: { url: '', number: 7, branch: 'cat-factory/login' },
      },
      { ref: { url: '', number: 1, branch: 'cat-factory/login' } },
    ])
    expect(outcome.failed).toBeNull()
    expect(outcome.merged.map((e) => e.repo ?? 'own')).toEqual(['o/email', 'own'])
    // Merged under the own installation, peer repo first.
    expect(mergePullRequest.mock.calls.map((c) => [(c[1] as any).repo, c[2]])).toEqual([
      ['email', 7],
      ['own', 1],
    ])
    expect(deleteBranch).toHaveBeenCalledTimes(2)
  })

  it('stops at the first failure and reports merged vs skipped (non-atomic partial merge)', async () => {
    // The peer merges, then the own-service merge throws → the own PR is `failed`; nothing is
    // skipped after it. The engine leaves the block blocked + notifies from this split.
    const mergePullRequest = vi.fn(async (_i: number, ref: { owner: string; repo: string }) => {
      if (ref.repo === 'own') throw new Error('branch protection')
    })
    const deleteBranch = vi.fn(async () => {})
    const merger = new GitHubPullRequestMerger({
      githubClient: { mergePullRequest, deleteBranch } as unknown as GitHubClient,
      resolveRepoTarget: async () => OWN_TARGET,
      blockRepository: { get: async () => MULTI_BLOCK } as any,
    })
    const outcome = await merger.mergePullRequests('ws', 'task_login', [
      { repo: 'o/email', frameId: 'frm_email', ref: { url: '', number: 7, branch: 'b' } },
      { ref: { url: '', number: 1, branch: 'b' } },
    ])
    expect(outcome.merged.map((e) => e.repo)).toEqual(['o/email'])
    expect(outcome.failed?.entry.repo).toBeUndefined() // the own-service PR failed
    expect(outcome.failed?.error).toContain('branch protection')
    expect(outcome.skipped).toEqual([])
    // Only the successfully merged peer branch is torn down.
    expect(deleteBranch).toHaveBeenCalledTimes(1)
  })
})
