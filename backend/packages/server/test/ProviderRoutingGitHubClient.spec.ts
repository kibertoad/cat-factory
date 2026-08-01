import type {
  GitHubClient,
  GitHubInstallation,
  GitHubInstallationRepository,
  GitHubRepo,
  Paged,
} from '@cat-factory/kernel'
import { describe, expect, it, vi } from 'vitest'
import { ProviderRoutingGitHubClient } from '../src/github/ProviderRoutingGitHubClient.js'

function installation(id: number, provider: 'github' | 'gitlab'): GitHubInstallation {
  return {
    installationId: id,
    workspaceId: `ws-${id}`,
    accountId: null,
    accountLogin: 'acme',
    targetType: 'User',
    appId: null,
    provider,
    cachedToken: null,
    tokenExpiresAt: null,
    accessToken: null,
    createdAt: 1,
    deletedAt: null,
  }
}

function fakeInstallations(rows: GitHubInstallation[]): {
  repo: GitHubInstallationRepository
  reads: () => number
} {
  const byId = new Map(rows.map((r) => [r.installationId, r]))
  let reads = 0
  return {
    reads: () => reads,
    repo: {
      getByInstallationId: async (id) => {
        reads += 1
        return byId.get(id) ?? null
      },
      listByInstallationIds: async () => [],
      getByWorkspace: async () => null,
      listWorkspacesForInstallation: async () => [],
      listActive: async () => [],
      listActiveForAccount: async () => [],
      upsert: async () => {},
      updateCachedToken: async () => {},
      softDelete: async () => {},
    },
  }
}

/** A stub GitHubClient that records which installation ids reached it, for the methods under test. */
function stubClient(tag: string): { client: GitHubClient; seen: number[] } {
  const seen: number[] = []
  const page: Paged<GitHubRepo> = { items: [{ ...({} as GitHubRepo), name: tag }] }
  const client = {
    listInstallationRepos: vi.fn(async (id: number) => {
      seen.push(id)
      return page
    }),
    listInstallations: vi.fn(async () => [
      { installationId: 1, accountLogin: tag, targetType: 'User' as const, accountAvatarUrl: null },
    ]),
    listReposForToken: vi.fn(async () => page),
  } as unknown as GitHubClient
  return { client, seen }
}

describe('ProviderRoutingGitHubClient', () => {
  it('routes an installation-keyed call to the client matching the stored provider', async () => {
    const { repo } = fakeInstallations([installation(1, 'github'), installation(2, 'gitlab')])
    const gh = stubClient('gh')
    const gl = stubClient('gl')
    const router = new ProviderRoutingGitHubClient({
      installations: repo,
      github: gh.client,
      gitlab: gl.client,
    })

    expect((await router.listInstallationRepos(1)).items[0]!.name).toBe('gh')
    expect((await router.listInstallationRepos(2)).items[0]!.name).toBe('gl')
    expect(gh.seen).toEqual([1])
    expect(gl.seen).toEqual([2])
  })

  it('memoises the provider per installation (no per-call repository read in a loop)', async () => {
    const { repo, reads } = fakeInstallations([installation(2, 'gitlab')])
    const gl = stubClient('gl')
    const router = new ProviderRoutingGitHubClient({ installations: repo, gitlab: gl.client })

    await router.listInstallationRepos(2)
    await router.listInstallationRepos(2)
    await router.listInstallationRepos(2)
    expect(gl.seen).toEqual([2, 2, 2])
    expect(reads()).toBe(1) // resolved once, then memoised
  })

  it('routes listInstallations (App discovery) to the GitHub client', async () => {
    const { repo } = fakeInstallations([])
    const gh = stubClient('gh')
    const gl = stubClient('gl')
    const router = new ProviderRoutingGitHubClient({
      installations: repo,
      github: gh.client,
      gitlab: gl.client,
    })
    const list = await router.listInstallations()
    expect(list[0]!.accountLogin).toBe('gh')
  })

  it('exposes token-keyed reads only when the GitHub client implements them, routed to GitHub', async () => {
    const { repo } = fakeInstallations([])
    const gh = stubClient('gh')
    const router = new ProviderRoutingGitHubClient({ installations: repo, github: gh.client })
    expect(typeof router.listReposForToken).toBe('function')
    expect((await router.listReposForToken!('tok')).items[0]!.name).toBe('gh')

    // GitLab-only: the GitHub client is absent, so the optional token-keyed method is not exposed.
    const glOnly = new ProviderRoutingGitHubClient({
      installations: repo,
      gitlab: stubClient('gl').client,
    })
    expect(glOnly.listReposForToken).toBeUndefined()
  })

  it('defaults an unknown installation to GitHub', async () => {
    const { repo } = fakeInstallations([])
    const gh = stubClient('gh')
    const gl = stubClient('gl')
    const router = new ProviderRoutingGitHubClient({
      installations: repo,
      github: gh.client,
      gitlab: gl.client,
    })
    await router.listInstallationRepos(999)
    expect(gh.seen).toEqual([999])
    expect(gl.seen).toEqual([])
  })
})
