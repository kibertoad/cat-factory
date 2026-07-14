import type { GitHubRepo, GroupCacheHandle } from '@cat-factory/kernel'
import { describe, expect, it } from 'vitest'
import { GitHubSyncService, type GitHubSyncServiceDependencies } from './GitHubSyncService.js'

// A minimal in-memory GroupCacheHandle mirroring layered-loader's contract: a hit returns the
// cached value; a miss runs `load` and stores its result; a THROWING load stores nothing and
// propagates (so a transient failure isn't cached). `${group}:${key}` scopes an entry to its group.
function makeCache<T>(): GroupCacheHandle<T> {
  const store = new Map<string, T>()
  const scope = (key: string, group: string) => `${group} ${key}`
  return {
    get: async (key, group, load) => {
      const k = scope(key, group)
      if (store.has(k)) return store.get(k) as T
      const value = await load()
      store.set(k, value)
      return value
    },
    invalidate: async (key, group) => void store.delete(scope(key, group)),
    invalidateGroup: async (group) => {
      // Deleting an already-yielded key mid-iteration is safe per the Map spec.
      for (const k of store.keys()) if (k.startsWith(`${group} `)) store.delete(k)
    },
    invalidateAll: async () => store.clear(),
  }
}

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
  viewerReposCache?: GroupCacheHandle<GitHubRepo[]>
}): { service: GitHubSyncService; access: AccessCalls; enumerations: () => number } {
  const access: AccessCalls = { replace: [], record: [] }
  const personal = opts.personal
  let enumerations = 0
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
        enumerations++
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
    ...(opts.viewerReposCache ? { viewerReposCache: opts.viewerReposCache } : {}),
    clock: { now: () => 123 },
  } as unknown as GitHubSyncServiceDependencies
  return { service: new GitHubSyncService(deps), access, enumerations: () => enumerations }
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

describe('GitHubSyncService.listAvailableRepos — viewer-repos cache', () => {
  const personalRepos = [repo(10, 'me', 'content-type-app-engine'), repo(11, 'me', 'scratch')]

  it('enumerates once and serves later keystrokes from the cache', async () => {
    const viewerReposCache = makeCache<GitHubRepo[]>()
    const { service, enumerations } = makePatService({
      appRepos: [],
      personal: { items: personalRepos },
      viewerReposCache,
    })
    const user = { userId: 'usr_a', userToken: 'tok' }

    const first = await service.listAvailableRepos('ws', { q: 'con', ...user })
    const second = await service.listAvailableRepos('ws', { q: 'content-type', ...user })

    // Both keystrokes filter the SAME cached enumeration in memory — one GitHub walk, not two.
    expect(first.map((r) => r.githubId)).toEqual([10])
    expect(second.map((r) => r.githubId)).toEqual([10])
    expect(enumerations()).toBe(1)
  })

  it('scopes the cache per user (a different viewer re-enumerates)', async () => {
    const viewerReposCache = makeCache<GitHubRepo[]>()
    const { service, enumerations } = makePatService({
      appRepos: [],
      personal: { items: personalRepos },
      viewerReposCache,
    })
    await service.listAvailableRepos('ws', { q: 'content', userId: 'usr_a', userToken: 'tok' })
    await service.listAvailableRepos('ws', { q: 'content', userId: 'usr_b', userToken: 'tok' })
    expect(enumerations()).toBe(2)
  })

  it('caches nothing on a transient enumeration failure (next keystroke retries)', async () => {
    const viewerReposCache = makeCache<GitHubRepo[]>()
    let calls = 0
    const { service } = makePatService({
      // An App repo that matches the query, so the degrade-to-App-only is observable.
      appRepos: [repo(1, 'acme', 'content-hub')],
      // Fail the first enumeration, succeed the second — a cached failure would starve the retry.
      personal: (() => {
        calls++
        if (calls === 1) throw new Error('503 unavailable')
        return { items: personalRepos }
      }) as unknown as () => never,
      viewerReposCache,
    })
    const user = { q: 'content', userId: 'usr_a', userToken: 'tok' }

    const first = await service.listAvailableRepos('ws', user)
    // Degrades to App-only, and the failure is NOT cached...
    expect(first.map((r) => r.githubId)).toEqual([1])
    const second = await service.listAvailableRepos('ws', user)
    // ...so the next keystroke re-enumerates and now finds the personal repo.
    expect(second.filter((r) => r.personal).map((r) => r.githubId)).toEqual([10])
    expect(calls).toBe(2)
  })

  it('drops the cached enumeration for a user when invalidated (PAT change)', async () => {
    const viewerReposCache = makeCache<GitHubRepo[]>()
    const { service, enumerations } = makePatService({
      appRepos: [],
      personal: { items: personalRepos },
      viewerReposCache,
    })
    const user = { q: 'content', userId: 'usr_a', userToken: 'tok' }
    await service.listAvailableRepos('ws', user)
    await viewerReposCache.invalidateGroup('usr_a')
    await service.listAvailableRepos('ws', user)
    expect(enumerations()).toBe(2)
  })
})
