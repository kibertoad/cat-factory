import type { GitHubRepo, GroupCacheHandle, Paged } from '@cat-factory/kernel'
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

function makeService(
  items: GitHubRepo[],
  opts: {
    getRepo?: (ref: { owner: string; repo: string }) => Promise<GitHubRepo>
    /** What the browse-all leg reports about its own page cap. */
    browseTruncated?: boolean
    /** What the search leg reports about its own caps (result count, or the listing it filters). */
    searchTruncated?: boolean
  } = {},
): { service: GitHubSyncService; searches: SearchCall[]; pointReads: string[] } {
  const searches: SearchCall[] = []
  const pointReads: string[] = []
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
      listInstallationRepos: async () => ({ items, truncated: opts.browseTruncated === true }),
      // Realtime search path: model the server-side `owner/name` match a query takes.
      searchInstallationRepos: async (
        installationId: number,
        query: string,
        // Named apart from the fixture's own `opts`, which the truncation flag below reads.
        searchOpts?: SearchCall['opts'],
      ) => {
        searches.push({ installationId, query, opts: searchOpts })
        const q = query.trim().toLowerCase()
        const matched = q
          ? items.filter((r) => `${r.owner}/${r.name}`.toLowerCase().includes(q))
          : []
        // Paged, like the real adapters: the caps live in the client, so the truncation flag comes
        // back WITH the rows. A count cannot stand in for it, which is the whole reason the port
        // carries the flag: a search that filtered a listing which itself truncated may return two
        // rows and still be a prefix.
        return { items: matched, truncated: opts.searchTruncated === true }
      },
      // Direct point-read for an exact `owner/name` query. Defaults to the GitHub 404
      // shape (a rejection) so slug-less specs never depend on it.
      getRepo: async (_installationId: number, ref: { owner: string; repo: string }) => {
        pointReads.push(`${ref.owner}/${ref.repo}`)
        if (opts.getRepo) return opts.getRepo(ref)
        throw new Error('HTTP 404')
      },
    },
    repoProjectionRepository: {
      list: async () => [],
    },
  } as unknown as GitHubSyncServiceDependencies
  return { service: new GitHubSyncService(deps), searches, pointReads }
}

/** The default fixture service, for a spec that asserts one thing about an ordinary listing. */
const service0 = (): GitHubSyncService => makeService(REPOS).service

describe('GitHubSyncService.listAvailableRepos', () => {
  it('returns every accessible repo when no query is given (browse-all)', async () => {
    const { service, searches } = makeService(REPOS)
    const { repos: result } = await service.listAvailableRepos('ws')
    expect(result.map((r) => r.githubId)).toEqual([1, 2, 3, 4])
    // Browse-all must NOT hit the realtime search path.
    expect(searches).toHaveLength(0)
  })

  it('searches server-side, scoped to the installation account, for a query', async () => {
    const { service, searches } = makeService(REPOS)
    const { repos: result } = await service.listAvailableRepos('ws', { q: 'api' })
    // Matches `acme/api-gateway` and `globex/API-client`, not `web-app`/`billing`.
    expect(result.map((r) => r.githubId).sort()).toEqual([1, 3])
    expect(searches).toEqual([
      { installationId: 1, query: 'api', opts: { owner: 'acme', ownerType: 'Organization' } },
    ])
  })

  it('matches on the owner segment too', async () => {
    const { service } = makeService(REPOS)
    const { repos: result } = await service.listAvailableRepos('ws', { q: 'globex' })
    expect(result.map((r) => r.githubId).sort()).toEqual([3, 4])
  })

  it('reports a browse that stopped at the page cap, so an absence is not read as unreachable', async () => {
    // The failure this exists for: a wide installation exceeds the enumeration cap, so a repository
    // that exists and links fine is simply missing from the rows. Without the flag, a caller told
    // "one that does not exist appears in neither read" concludes the wrong one.
    const { service } = makeService(REPOS, { browseTruncated: true })
    const listing = await service.listAvailableRepos('ws')
    expect(listing.truncated).toBe(true)
    expect(listing.repos).toHaveLength(4)
  })

  it('reports a complete browse as complete', async () => {
    expect((await service0().listAvailableRepos('ws')).truncated).toBe(false)
  })

  it('reports a search the CLIENT capped, which no row count could have revealed', async () => {
    // Why the port carries the flag rather than leaving the service to infer it: a search that
    // filters a bounded listing can return two rows and still be a prefix, because a match beyond
    // the listing's own page cap was never filtered at all.
    const { service } = makeService(REPOS, { searchTruncated: true })
    const listing = await service.listAvailableRepos('ws', { q: 'api' })
    expect(listing.truncated).toBe(true)
    expect(listing.repos.length).toBeGreaterThan(0)
  })

  it('treats a blank/whitespace query as browse-all, not a search', async () => {
    const { service, searches } = makeService(REPOS)
    const { repos: result } = await service.listAvailableRepos('ws', { q: '   ' })
    expect(result).toHaveLength(4)
    expect(searches).toHaveLength(0)
  })

  it('returns an empty list when the query matches nothing', async () => {
    const { service } = makeService(REPOS)
    const { repos: result } = await service.listAvailableRepos('ws', { q: 'nonexistent' })
    expect(result).toEqual([])
  })

  it('collapses a pasted repo URL to its slug and resolves it by point-read, not search', async () => {
    // The repo is reachable via getRepo but NOT surfaced by the name search (models
    // GitHub's tokenized search missing an exact slug — the "no repositories found
    // for [full url]" bug).
    const hidden = repo(9, 'acme', 'internal-tool')
    const { service, searches, pointReads } = makeService([], {
      getRepo: async (ref) => {
        if (ref.owner === 'acme' && ref.repo === 'internal-tool') return hidden
        throw new Error('HTTP 404')
      },
    })
    const { repos: result } = await service.listAvailableRepos('ws', {
      q: 'https://github.com/acme/internal-tool/tree/main/docs',
    })
    expect(result.map((r) => r.githubId)).toEqual([9])
    // The search leg receives the collapsed slug, never the raw URL.
    expect(searches).toEqual([
      {
        installationId: 1,
        query: 'acme/internal-tool',
        opts: { owner: 'acme', ownerType: 'Organization' },
      },
    ])
    expect(pointReads).toEqual(['acme/internal-tool'])
  })

  it('dedups the point-read hit against the search results, direct hit first', async () => {
    const { service } = makeService(REPOS, {
      getRepo: async (ref) => {
        if (ref.owner === 'acme' && ref.repo === 'api-gateway') return REPOS[0]!
        throw new Error('HTTP 404')
      },
    })
    const { repos: result } = await service.listAvailableRepos('ws', { q: 'acme/api-gateway' })
    // Search substring-matches repo 1 too; the merged list holds it once.
    expect(result.map((r) => r.githubId)).toEqual([1])
  })

  it('falls back to the search results when the point-read 404s', async () => {
    const { service, pointReads } = makeService(REPOS)
    const { repos: result } = await service.listAvailableRepos('ws', { q: 'acme/api-gateway' })
    expect(pointReads).toEqual(['acme/api-gateway'])
    expect(result.map((r) => r.githubId)).toEqual([1])
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
  viewerReposCache?: GroupCacheHandle<Paged<GitHubRepo>>
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
        const matched = q
          ? opts.appRepos.filter((r) => `${r.owner}/${r.name}`.toLowerCase().includes(q))
          : []
        return { items: matched, truncated: false }
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
    const { repos: result } = await service.listAvailableRepos('ws', {
      userId: 'usr_a',
      userToken: 'tok',
    })
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
    const { repos: result } = await service.listAvailableRepos('ws', {
      userId: 'usr_a',
      userToken: 'tok',
    })
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
    const { repos: result } = await service.listAvailableRepos('ws', {
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
    const viewerReposCache = makeCache<Paged<GitHubRepo>>()
    const { service, enumerations } = makePatService({
      appRepos: [],
      personal: { items: personalRepos },
      viewerReposCache,
    })
    const user = { userId: 'usr_a', userToken: 'tok' }

    const { repos: first } = await service.listAvailableRepos('ws', { q: 'con', ...user })
    const { repos: second } = await service.listAvailableRepos('ws', { q: 'content-type', ...user })

    // Both keystrokes filter the SAME cached enumeration in memory — one GitHub walk, not two.
    expect(first.map((r) => r.githubId)).toEqual([10])
    expect(second.map((r) => r.githubId)).toEqual([10])
    expect(enumerations()).toBe(1)
  })

  it('scopes the cache per user (a different viewer re-enumerates)', async () => {
    const viewerReposCache = makeCache<Paged<GitHubRepo>>()
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
    const viewerReposCache = makeCache<Paged<GitHubRepo>>()
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

    const { repos: first } = await service.listAvailableRepos('ws', user)
    // Degrades to App-only, and the failure is NOT cached...
    expect(first.map((r) => r.githubId)).toEqual([1])
    const { repos: second } = await service.listAvailableRepos('ws', user)
    // ...so the next keystroke re-enumerates and now finds the personal repo.
    expect(second.filter((r) => r.personal).map((r) => r.githubId)).toEqual([10])
    expect(calls).toBe(2)
  })

  it('drops the cached enumeration for a user when invalidated (PAT change)', async () => {
    const viewerReposCache = makeCache<Paged<GitHubRepo>>()
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

// `linkRepoBySlug`: the resolution behind `POST /api/v1/repos/link`, which is the only door a
// HEADLESS caller has. It resolves through `listAvailableRepos` above rather than a bare `getRepo`,
// so everything the picker can reach it can adopt, and the two properties worth pinning are the ones
// whose failure is a wrong repository rather than an error: the OWNER is part of the match, and an
// unreachable name is null rather than a guess.
describe('GitHubSyncService.linkRepoBySlug', () => {
  /** A service whose projection starts empty and records what `linkRepo` upserts. */
  function makeLinker(items: GitHubRepo[]): {
    service: GitHubSyncService
    linked: GitHubRepo[]
  } {
    const linked: GitHubRepo[] = []
    const deps = {
      clock: { now: () => 0 },
      githubInstallationRepository: {
        getByWorkspace: async () => ({
          installationId: 1,
          deletedAt: null,
          accountLogin: 'acme',
          targetType: 'Organization',
          provider: 'github',
        }),
        // `linkRepo` deep-syncs what it just projected, which fans the resources out to every
        // workspace linking the repo. One workspace here, so the sync is a no-op with real ports.
        listWorkspacesForInstallation: async () => ['ws'],
      },
      githubClient: {
        listInstallationRepos: async () => ({ items }),
        searchInstallationRepos: async (_id: number, query: string) => {
          const q = query.trim().toLowerCase()
          const matched = q
            ? items.filter((r) => `${r.owner}/${r.name}`.toLowerCase().includes(q))
            : []
          return { items: matched, truncated: false }
        },
        // The resource wave `syncRepo` fires after a link; empty pages settle it at once. Stubbed
        // rather than avoided because the deep sync is part of what linking MEANS, so a test that
        // skipped it would be asserting a method this one does not have.
        listBranches: async () => ({ items: [] }),
        listPullRequests: async () => ({ items: [] }),
        listIssues: async () => ({ items: [] }),
        listCommits: async () => ({ items: [] }),
        listCheckRuns: async () => ({ items: [] }),
        getRepo: async (_id: number, ref: { owner: string; repo: string }) => {
          const hit = items.find((r) => r.owner === ref.owner && r.name === ref.repo)
          if (!hit) throw new Error('HTTP 404')
          return hit
        },
        getRepoById: async (_id: number, githubId: number) =>
          items.find((r) => r.githubId === githubId) ?? null,
      },
      repoProjectionRepository: {
        list: async () => linked,
        get: async (_ws: string, githubId: number) =>
          linked.find((r) => r.githubId === githubId) ?? null,
        // A real UPSERT, keyed by provider id: the link writes the row and the deep sync re-stamps
        // it, so a fake that appended would report one adopted repository as two.
        upsertMany: async (_ws: string, rows: GitHubRepo[]) => {
          for (const row of rows) {
            const at = linked.findIndex((held) => held.githubId === row.githubId)
            if (at === -1) linked.push(row)
            else linked[at] = row
          }
        },
        linkedWorkspaces: async () => ['ws'],
        getCursor: async () => null,
        setCursor: async () => {},
      },
      branchProjectionRepository: { upsertMany: async () => {} },
      pullRequestProjectionRepository: { upsertMany: async () => {} },
      issueProjectionRepository: { upsertMany: async () => {} },
      commitProjectionRepository: { upsertMany: async () => {} },
      checkRunProjectionRepository: { upsertMany: async () => {} },
    } as unknown as GitHubSyncServiceDependencies
    return { service: new GitHubSyncService(deps), linked }
  }

  it('links a repo the connection can reach but the workspace has not adopted', async () => {
    const { service, linked } = makeLinker(REPOS)
    const result = await service.linkRepoBySlug('ws', 'acme', 'api-gateway')
    expect(result?.githubId).toBe(1)
    expect(linked.map((r) => r.githubId)).toEqual([1])
  })

  it('matches the name case-insensitively, as both providers treat one', async () => {
    const { service } = makeLinker(REPOS)
    expect((await service.linkRepoBySlug('ws', 'GLOBEX', 'api-client'))?.githubId).toBe(3)
  })

  it('refuses a same-named repository under ANOTHER owner rather than substituting it', async () => {
    // The failure this guard exists for: a slug search can surface a look-alike, and linking that one
    // would file a caller's work in someone else's account while answering 200.
    const { service, linked } = makeLinker(REPOS)
    expect(await service.linkRepoBySlug('ws', 'acme', 'billing')).toBeNull()
    expect(linked).toEqual([])
  })

  it('answers null for a name nothing reaches, which the caller reports as a refusal', async () => {
    const { service } = makeLinker(REPOS)
    expect(await service.linkRepoBySlug('ws', 'acme', 'nonexistent')).toBeNull()
  })

  it('answers a repository this workspace ALREADY links, even when nothing reaches it now', async () => {
    // The idempotency the endpoint promises, against the case that breaks it: a repository the
    // workspace links but the connection no longer surfaces (a personal repo adopted through
    // somebody's own token, or an App grant since narrowed). Resolving only through the provider
    // answered a 404 for a repository `GET /api/v1/repos` lists, which tells a re-running setup
    // script to go and create one that exists.
    const { service, linked } = makeLinker([])
    const held = { ...REPOS[0]!, linkedVia: 'user_pat' as const }
    linked.push(held)
    const result = await service.linkRepoBySlug('ws', 'ACME', 'API-Gateway')
    expect(result?.githubId).toBe(held.githubId)
    // And nothing was re-projected: the row it answered with is the one already there.
    expect(linked).toEqual([held])
  })
})
