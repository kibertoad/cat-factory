import type { BranchProtectionSummary, GitHubClient, GitHubRepo } from '@cat-factory/kernel'
import { describe, expect, it } from 'vitest'
import { GitHubService, type GitHubServiceDependencies } from './GitHubService.js'

// The branch-protection preflight's REPORT ASSEMBLY — the probe itself is pinned separately in
// `@cat-factory/server`'s `branchProtection.spec.ts`. What is under test here is everything the
// operator reads as a claim about coverage: that an unanswerable provider says so instead of
// returning an empty list, that a cap states what it dropped, and that the fan-out stays
// bounded. Each of those, wrong, turns the report into a confident all-clear
// (`backend/docs/security-model.md`, checklist item 1).

const repo = (githubId: number, over: Partial<GitHubRepo> = {}): GitHubRepo =>
  ({
    githubId,
    owner: 'acme',
    name: `repo-${githubId}`,
    defaultBranch: 'main',
    private: false,
    installationId: 7,
    syncedAt: 0,
    ...over,
  }) as GitHubRepo

const PROTECTED: BranchProtectionSummary = {
  state: 'protected',
  detail: {
    requiresPullRequest: true,
    requiredApprovingReviewCount: 1,
    requiredStatusChecks: [],
    allowsForcePush: false,
  },
}

/** A service over the given repos, with a probe recording every call it received. */
function build(
  repos: GitHubRepo[],
  probe?: GitHubClient['getBranchProtection'],
  onProbe?: (ref: { owner: string; repo: string }, branch: string) => void,
) {
  const calls: Array<{ installationId: number; repo: string; branch: string }> = []
  const githubClient = (
    probe === undefined
      ? {}
      : {
          getBranchProtection: async (
            installationId: number,
            ref: { owner: string; repo: string },
            branch: string,
          ) => {
            calls.push({ installationId, repo: ref.repo, branch })
            onProbe?.(ref, branch)
            return probe(installationId, ref, branch)
          },
        }
  ) as GitHubClient
  const service = new GitHubService({
    githubClient,
    repoProjectionRepository: { list: async () => repos },
  } as unknown as GitHubServiceDependencies)
  return { service, calls }
}

describe('GitHubService.checkDefaultBranchProtection', () => {
  it('reports the capability as unavailable rather than an empty list', async () => {
    // GitLab today: the port method is optional. An empty `repos` with `capability: 'ok'` would
    // render as a clean bill of health for a provider that answered nothing at all.
    const { service } = build([repo(1)])

    expect(await service.checkDefaultBranchProtection('ws_1')).toEqual({
      capability: 'unavailable',
      repos: [],
      omittedRepos: 0,
    })
  })

  it('probes every linked repo and reports none omitted when under the cap', async () => {
    const { service, calls } = build([repo(1), repo(2)], async () => PROTECTED)

    const report = await service.checkDefaultBranchProtection('ws_1')

    expect(report.capability).toBe('ok')
    expect(report.omittedRepos).toBe(0)
    expect(report.repos.map((r) => r.repoGithubId)).toEqual([1, 2])
    expect(calls.map((c) => c.repo)).toEqual(['repo-1', 'repo-2'])
  })

  it('COUNTS what the cap left unprobed instead of truncating silently', async () => {
    // The count is the whole difference between "these are all your repositories" and the
    // truth. A report that dropped the tail silently is the same failure as calling an
    // unprobed repo protected.
    const { service, calls } = build(
      Array.from({ length: 5 }, (_, i) => repo(i + 1)),
      async () => PROTECTED,
    )

    const report = await service.checkDefaultBranchProtection('ws_1', { maxRepos: 2 })

    expect(report.repos).toHaveLength(2)
    expect(report.omittedRepos).toBe(3)
    // Only the probed prefix cost a live read — the cap bounds spend, not just output.
    expect(calls).toHaveLength(2)
  })

  it('probes the projection default branch, falling back to main when it has none', async () => {
    // A repo linked before its first sync carries no default branch. The row still appears,
    // and the probe answers `branch_not_found` against the guess — which is honest. Dropping
    // the row instead would read as one fewer repository needing attention.
    const { service, calls } = build(
      [repo(1, { defaultBranch: 'trunk' }), repo(2, { defaultBranch: null as unknown as string })],
      async () => ({ state: 'unknown', reason: 'branch_not_found' }),
    )

    const report = await service.checkDefaultBranchProtection('ws_1')

    expect(calls.map((c) => c.branch)).toEqual(['trunk', 'main'])
    expect(report.repos.map((r) => r.defaultBranch)).toEqual(['trunk', 'main'])
  })

  it('bounds the fan-out, so a large installation is not a burst of concurrent reads', async () => {
    // Concurrency, not just total count: GitHub answers a burst against one installation with
    // an abuse-detection 403, and workerd caps a request's subrequests. Neither degrades
    // gracefully, and both would land on an operator opening a security panel.
    let inFlight = 0
    let peak = 0
    const { service } = build(
      Array.from({ length: 24 }, (_, i) => repo(i + 1)),
      async () => {
        inFlight++
        peak = Math.max(peak, inFlight)
        await new Promise((resolve) => setTimeout(resolve, 1))
        inFlight--
        return PROTECTED
      },
    )

    const report = await service.checkDefaultBranchProtection('ws_1', { concurrency: 3 })

    expect(report.repos).toHaveLength(24)
    expect(peak).toBe(3)
  })

  it('keeps rows in projection order even when a probe settles out of order', async () => {
    // The SPA sorts by state for display but keys rows by id; a caller that zipped the report
    // against its own repo list would silently mislabel every row if order were completion order.
    const delays: Record<string, number> = { 'repo-1': 20, 'repo-2': 1, 'repo-3': 10 }
    const { service } = build([repo(1), repo(2), repo(3)], async (_id, ref) => {
      await new Promise((resolve) => setTimeout(resolve, delays[ref.repo]))
      return PROTECTED
    })

    const report = await service.checkDefaultBranchProtection('ws_1', { concurrency: 3 })

    expect(report.repos.map((r) => r.name)).toEqual(['repo-1', 'repo-2', 'repo-3'])
  })
})
