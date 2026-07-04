import type { GitHubRepo } from '@cat-factory/kernel'
import { describe, expect, it } from 'vitest'
import { GitHubSyncService, type GitHubSyncServiceDependencies } from './GitHubSyncService.js'

// Focused coverage for the add-service repo picker's typeahead: a query is matched
// server-side in realtime (searchInstallationRepos), while a blank query browses the whole
// installation (listInstallationRepos). Only the ports `listAvailableRepos` touches are
// stubbed, with a fake search client that models GitHub's `owner/name` matching.

const repo = (githubId: number, owner: string, name: string): GitHubRepo =>
  ({
    githubId,
    owner,
    name,
    defaultBranch: 'main',
    private: false,
    installationId: 1,
    syncedAt: 0,
  }) as GitHubRepo

const REPOS = [
  repo(1, 'acme', 'api-gateway'),
  repo(2, 'acme', 'web-app'),
  repo(3, 'globex', 'API-client'),
  repo(4, 'globex', 'billing'),
]

interface SearchCall {
  installationId: number
  query: string
  opts?: { owner?: string; ownerType?: 'Organization' | 'User'; limit?: number }
}

function makeService(items: GitHubRepo[]): { service: GitHubSyncService; searches: SearchCall[] } {
  const searches: SearchCall[] = []
  const deps = {
    githubInstallationRepository: {
      getByWorkspace: async () => ({
        installationId: 1,
        deletedAt: null,
        accountLogin: 'acme',
        targetType: 'Organization',
      }),
    },
    githubClient: {
      // Browse-all path (blank query).
      listInstallationRepos: async () => ({ items }),
      // Realtime search path: model the server-side `owner/name` match a query takes.
      searchInstallationRepos: async (
        installationId: number,
        query: string,
        opts?: SearchCall['opts'],
      ) => {
        searches.push({ installationId, query, opts })
        const q = query.trim().toLowerCase()
        return q ? items.filter((r) => `${r.owner}/${r.name}`.toLowerCase().includes(q)) : []
      },
    },
    repoProjectionRepository: {
      list: async () => [],
    },
  } as unknown as GitHubSyncServiceDependencies
  return { service: new GitHubSyncService(deps), searches }
}

describe('GitHubSyncService.listAvailableRepos', () => {
  it('returns every accessible repo when no query is given (browse-all)', async () => {
    const { service, searches } = makeService(REPOS)
    const result = await service.listAvailableRepos('ws')
    expect(result.map((r) => r.githubId)).toEqual([1, 2, 3, 4])
    // Browse-all must NOT hit the realtime search path.
    expect(searches).toHaveLength(0)
  })

  it('searches server-side, scoped to the installation account, for a query', async () => {
    const { service, searches } = makeService(REPOS)
    const result = await service.listAvailableRepos('ws', { q: 'api' })
    // Matches `acme/api-gateway` and `globex/API-client`, not `web-app`/`billing`.
    expect(result.map((r) => r.githubId).sort()).toEqual([1, 3])
    expect(searches).toEqual([
      { installationId: 1, query: 'api', opts: { owner: 'acme', ownerType: 'Organization' } },
    ])
  })

  it('matches on the owner segment too', async () => {
    const { service } = makeService(REPOS)
    const result = await service.listAvailableRepos('ws', { q: 'globex' })
    expect(result.map((r) => r.githubId).sort()).toEqual([3, 4])
  })

  it('treats a blank/whitespace query as browse-all, not a search', async () => {
    const { service, searches } = makeService(REPOS)
    const result = await service.listAvailableRepos('ws', { q: '   ' })
    expect(result).toHaveLength(4)
    expect(searches).toHaveLength(0)
  })

  it('returns an empty list when the query matches nothing', async () => {
    const { service } = makeService(REPOS)
    const result = await service.listAvailableRepos('ws', { q: 'nonexistent' })
    expect(result).toEqual([])
  })
})

// Coverage for the personal-PAT picker expansion + its fail-closed access-cache refresh.
interface AccessCalls {
  replace: { userId: string; count: number }[]
  record: { userId: string; count: number }[]
}

function makePatService(opts: {
  appRepos: GitHubRepo[]
  personal?: { items: GitHubRepo[]; truncated?: boolean } | (() => never)
}): { service: GitHubSyncService; access: AccessCalls } {
  const access: AccessCalls = { replace: [], record: [] }
  const personal = opts.personal
  const deps = {
    githubInstallationRepository: {
      getByWorkspace: async () => ({
        installationId: 1,
        deletedAt: null,
        accountLogin: 'acme',
        targetType: 'Organization',
      }),
    },
    githubClient: {
      listInstallationRepos: async () => ({ items: opts.appRepos }),
      searchInstallationRepos: async (_id: number, query: string) => {
        const q = query.trim().toLowerCase()
        return q
          ? opts.appRepos.filter((r) => `${r.owner}/${r.name}`.toLowerCase().includes(q))
          : []
      },
      listReposForToken: async () => {
        if (typeof personal === 'function') return personal()
        return { items: personal?.items ?? [], truncated: personal?.truncated }
      },
    },
    repoProjectionRepository: { list: async () => [] },
    userRepoAccessRepository: {
      replaceForUser: async (userId: string, repos: unknown[]) =>
        void access.replace.push({ userId, count: repos.length }),
      recordAccessible: async (userId: string, repos: unknown[]) =>
        void access.record.push({ userId, count: repos.length }),
    },
    clock: { now: () => 123 },
  } as unknown as GitHubSyncServiceDependencies
  return { service: new GitHubSyncService(deps), access }
}

describe('GitHubSyncService.listAvailableRepos — personal PAT expansion', () => {
  const personalRepos = [repo(10, 'me', 'private-tool'), repo(11, 'me', 'scratch')]

  it('merges PAT-reachable repos (badged personal) and records them on a blank browse', async () => {
    const { service, access } = makePatService({
      appRepos: [REPOS[0]!],
      personal: { items: personalRepos },
    })
    const result = await service.listAvailableRepos('ws', { userId: 'usr_a', userToken: 'tok' })
    expect(result.filter((r) => r.personal).map((r) => r.githubId)).toEqual([10, 11])
    // Blank browse-all → the full accessible set is REPLACED (fail-closed cache refresh).
    expect(access.replace).toEqual([{ userId: 'usr_a', count: 2 }])
    expect(access.record).toHaveLength(0)
  })

  it('degrades to App-only (never throws) when the PAT enumeration fails', async () => {
    const { service, access } = makePatService({
      appRepos: [REPOS[0]!],
      personal: () => {
        throw new Error('401 bad credentials')
      },
    })
    const result = await service.listAvailableRepos('ws', { userId: 'usr_a', userToken: 'tok' })
    // The App repo still renders; no personal repos; nothing recorded.
    expect(result.map((r) => r.githubId)).toEqual([1])
    expect(access.replace).toHaveLength(0)
    expect(access.record).toHaveLength(0)
  })

  it('records additively (never replaces) when the enumeration is truncated', async () => {
    const { service, access } = makePatService({
      appRepos: [],
      personal: { items: personalRepos, truncated: true },
    })
    await service.listAvailableRepos('ws', { userId: 'usr_a', userToken: 'tok' })
    expect(access.record).toEqual([{ userId: 'usr_a', count: 2 }])
    expect(access.replace).toHaveLength(0)
  })

  it('does NOT rewrite the access cache on a search (only a blank browse)', async () => {
    const { service, access } = makePatService({
      appRepos: [],
      personal: { items: personalRepos },
    })
    const result = await service.listAvailableRepos('ws', {
      q: 'scratch',
      userId: 'usr_a',
      userToken: 'tok',
    })
    // The search still filters the PAT set in memory, but writes nothing.
    expect(result.map((r) => r.githubId)).toEqual([11])
    expect(access.replace).toHaveLength(0)
    expect(access.record).toHaveLength(0)
  })
})
