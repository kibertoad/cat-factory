import type { GitHubRepo } from '@cat-factory/kernel'
import { describe, expect, it } from 'vitest'
import { GitHubSyncService, type GitHubSyncServiceDependencies } from './GitHubSyncService.js'

// Item 12 (performance-optimizations tracker): GitHubSyncService used to fetch a repo's
// resources serially and fan each projection out to the linking workspaces one-after-another,
// and to resync repos / backfill workspaces in serial loops. These tests pin the parallelism:
// the independent resource fetches run in one wave, the per-workspace writes fan out
// concurrently, and the data-scaled loops run with bounded concurrency (not serial, not an
// unbounded burst).

const tick = () => new Promise((r) => setTimeout(r, 5))

/** A max-concurrency probe: `enter` marks a task in-flight, yields, then settles. */
function concurrencyProbe() {
  let inFlight = 0
  let max = 0
  const enter = async <T>(result: T): Promise<T> => {
    inFlight++
    max = Math.max(max, inFlight)
    await tick()
    inFlight--
    return result
  }
  return {
    enter,
    get max() {
      return max
    },
  }
}

const repo = (githubId: number, name = `repo-${githubId}`): GitHubRepo =>
  ({
    githubId,
    owner: 'acme',
    name,
    defaultBranch: 'main',
    private: false,
    installationId: 1,
    syncedAt: 0,
  }) as GitHubRepo

const emptyResource = { items: [] as never[] }

describe('GitHubSyncService — dispatch parallelism (tracker item 12)', () => {
  it('fetches the four independent cursor resources in one concurrent wave', async () => {
    const probe = concurrencyProbe()
    const deps = {
      githubInstallationRepository: { listWorkspacesForInstallation: async () => ['ws'] },
      githubClient: {
        listBranches: async () => probe.enter(emptyResource),
        listPullRequests: async () => probe.enter(emptyResource),
        listIssues: async () => probe.enter(emptyResource),
        listCommits: async () => probe.enter(emptyResource),
        listCheckRuns: async () => emptyResource,
      },
      repoProjectionRepository: {
        linkedWorkspaces: async (_id: number, candidates: string[]) => candidates,
        getCursor: async () => null,
        setCursor: async () => {},
        upsertMany: async () => {},
      },
      branchProjectionRepository: { upsertMany: async () => {} },
      pullRequestProjectionRepository: { upsertMany: async () => {} },
      issueProjectionRepository: { upsertMany: async () => {} },
      commitProjectionRepository: { upsertMany: async () => {} },
      checkRunProjectionRepository: { upsertMany: async () => {} },
      clock: { now: () => 0 },
    } as unknown as GitHubSyncServiceDependencies

    await new GitHubSyncService(deps).syncRepo(repo(1))
    // Branches, PRs, issues and commits are all in flight together — serial would peak at 1.
    expect(probe.max).toBe(4)
  })

  it('fans a resource out to every linking workspace concurrently', async () => {
    const probe = concurrencyProbe()
    const workspaces = ['ws-a', 'ws-b', 'ws-c']
    const deps = {
      githubInstallationRepository: { listWorkspacesForInstallation: async () => workspaces },
      githubClient: {
        // Non-empty branches so the branch fan-out actually writes to each workspace.
        listBranches: async () => ({ items: [{ name: 'main', headSha: 'sha1' }] }),
        listPullRequests: async () => emptyResource,
        listIssues: async () => emptyResource,
        listCommits: async () => emptyResource,
        listCheckRuns: async () => emptyResource,
      },
      repoProjectionRepository: {
        linkedWorkspaces: async (_id: number, candidates: string[]) => candidates,
        getCursor: async () => null,
        setCursor: async () => {},
        upsertMany: async () => {},
      },
      branchProjectionRepository: { upsertMany: async () => probe.enter(undefined) },
      pullRequestProjectionRepository: { upsertMany: async () => {} },
      issueProjectionRepository: { upsertMany: async () => {} },
      commitProjectionRepository: { upsertMany: async () => {} },
      checkRunProjectionRepository: { upsertMany: async () => {} },
      clock: { now: () => 0 },
    } as unknown as GitHubSyncServiceDependencies

    await new GitHubSyncService(deps).syncRepo(repo(1))
    // All three per-workspace branch writes overlap — serial would peak at 1.
    expect(probe.max).toBe(workspaces.length)
  })

  it('resyncWorkspace resyncs repos with bounded concurrency (not serial, not unbounded)', async () => {
    const probe = concurrencyProbe()
    const deps = {
      repoProjectionRepository: {
        list: async () => Array.from({ length: 10 }, (_v, i) => repo(i)),
      },
      clock: { now: () => 0 },
    } as unknown as GitHubSyncServiceDependencies

    const service = new GitHubSyncService(deps)
    // Replace syncRepo with a concurrency probe; resyncWorkspace dispatches through `this`.
    ;(service as unknown as { syncRepo: () => Promise<void> }).syncRepo = () =>
      probe.enter(undefined)
    await service.resyncWorkspace('ws')
    // REPO_SYNC_CONCURRENCY = 4: parallel but capped, so 10 repos peak at exactly 4.
    expect(probe.max).toBe(4)
  })

  it('backfillInstallation resyncs workspaces with bounded concurrency', async () => {
    const probe = concurrencyProbe()
    const deps = {
      githubInstallationRepository: {
        getByInstallationId: async () => ({ installationId: 1, deletedAt: null }),
        listWorkspacesForInstallation: async () => Array.from({ length: 9 }, (_v, i) => `ws-${i}`),
      },
      clock: { now: () => 0 },
    } as unknown as GitHubSyncServiceDependencies

    const service = new GitHubSyncService(deps)
    ;(service as unknown as { resyncWorkspace: () => Promise<void> }).resyncWorkspace = () =>
      probe.enter(undefined)
    await service.backfillInstallation(1)
    // WORKSPACE_BACKFILL_CONCURRENCY = 3.
    expect(probe.max).toBe(3)
  })
})
