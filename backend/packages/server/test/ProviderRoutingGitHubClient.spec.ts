import type {
  BranchProtectionSummary,
  GitHubClient,
  GitHubInstallation,
  GitHubInstallationRepository,
  GitHubRepo,
  Paged,
} from '@cat-factory/kernel'
import { VcsCapabilityUnsupportedError } from '@cat-factory/kernel'
import { FetchGitHubClient } from '../src/github/FetchGitHubClient.js'
import { describe, expect, it, vi } from 'vitest'
import { providerRoutingGitHubClient } from '../src/github/ProviderRoutingGitHubClient.js'

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

describe('providerRoutingGitHubClient', () => {
  it('routes an installation-keyed call to the client matching the stored provider', async () => {
    const { repo } = fakeInstallations([installation(1, 'github'), installation(2, 'gitlab')])
    const gh = stubClient('gh')
    const gl = stubClient('gl')
    const router = providerRoutingGitHubClient({
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
    const router = providerRoutingGitHubClient({ installations: repo, gitlab: gl.client })

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
    const router = providerRoutingGitHubClient({
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
    const router = providerRoutingGitHubClient({ installations: repo, github: gh.client })
    expect(typeof router.listReposForToken).toBe('function')
    expect((await router.listReposForToken!('tok')).items[0]!.name).toBe('gh')

    // GitLab-only: the GitHub client is absent, so the optional token-keyed method is not exposed.
    const glOnly = providerRoutingGitHubClient({
      installations: repo,
      gitlab: stubClient('gl').client,
    })
    expect(glOnly.listReposForToken).toBeUndefined()
  })

  it('defaults an unknown installation to GitHub', async () => {
    const { repo } = fakeInstallations([])
    const gh = stubClient('gh')
    const gl = stubClient('gl')
    const router = providerRoutingGitHubClient({
      installations: repo,
      github: gh.client,
      gitlab: gl.client,
    })
    await router.listInstallationRepos(999)
    expect(gh.seen).toEqual([999])
    expect(gl.seen).toEqual([])
  })

  // ---- surface ------------------------------------------------------------

  it('forwards every method the port declares, not just the required ones', () => {
    // The whole reason this is a Proxy. The hand-written delegate it replaced implemented the 33
    // required members and 18 of the 20 OPTIONAL ones were simply missing, which TypeScript
    // accepts, because they are optional, so nothing failed to compile and every consumer's
    // `client.x?.(…)` feature-test quietly reported the capability as absent for a deployment
    // that had it. Reflecting the real client's own surface (a `FetchGitHubClient`, which
    // implements all of it) is what makes the next added port method structural rather than a
    // line someone has to remember to add here.
    const declared = Object.getOwnPropertyNames(FetchGitHubClient.prototype).filter(
      (name) => name !== 'constructor',
    )
    const router = providerRoutingGitHubClient({
      installations: fakeInstallations([]).repo,
      github: Object.create(FetchGitHubClient.prototype) as GitHubClient,
    })
    const missing = declared.filter(
      (name) => typeof (router as unknown as Record<string, unknown>)[name] !== 'function',
    )
    expect(missing).toEqual([])
  })

  it('advertises an optional method neither client implements as absent', () => {
    // The other half of the contract: the router must not claim a capability nobody has, or a
    // consumer's feature-test degrades to a runtime failure instead of its fallback.
    const router = providerRoutingGitHubClient({
      installations: fakeInstallations([]).repo,
      github: stubClient('gh').client,
      gitlab: stubClient('gl').client,
    })
    expect(router.getBranchProtection).toBeUndefined()
    expect('getBranchProtection' in router).toBe(false)
  })

  it('routes an optional method only one provider implements, per installation', async () => {
    // The concrete bug: `getBranchProtection` exists on the App client and not on the GitLab
    // adapter, so the delegate dropped it and the workspace security report read
    // `capability: 'unavailable'` even for the GitHub installations it could answer for.
    const { repo } = fakeInstallations([installation(1, 'github'), installation(2, 'gitlab')])
    const summary: BranchProtectionSummary = { state: 'protected' }
    const gh = {
      ...stubClient('gh').client,
      getBranchProtection: vi.fn(async () => summary),
    } as unknown as GitHubClient
    const router = providerRoutingGitHubClient({
      installations: repo,
      github: gh,
      gitlab: stubClient('gl').client,
    })

    expect(typeof router.getBranchProtection).toBe('function')
    await expect(router.getBranchProtection!(1, { owner: 'a', repo: 'b' }, 'main')).resolves.toBe(
      summary,
    )

    // The GitLab installation genuinely cannot answer. That is a different fact from "not wired",
    // so it refuses BY NAME rather than failing as `undefined is not a function`.
    await expect(
      router.getBranchProtection!(2, { owner: 'a', repo: 'b' }, 'main'),
    ).rejects.toBeInstanceOf(VcsCapabilityUnsupportedError)
  })

  // ---- protocol keys ------------------------------------------------------

  it('is not a thenable', async () => {
    // A Proxy that answers `then` with a routing function makes the promise machinery call it
    // with `(resolve, reject)`, routed as if `resolve` were an installation id, and the
    // awaiting promise never settles. Awaiting the client must yield the client.
    const router = providerRoutingGitHubClient({
      installations: fakeInstallations([]).repo,
      github: stubClient('gh').client,
    })
    expect(await Promise.resolve(router)).toBe(router)
    expect((router as unknown as { then?: unknown }).then).toBeUndefined()
  })

  it('answers undefined for serialization and symbol protocol keys', () => {
    const router = providerRoutingGitHubClient({
      installations: fakeInstallations([]).repo,
      github: stubClient('gh').client,
    })
    expect((router as unknown as { toJSON?: unknown }).toJSON).toBeUndefined()
    expect((router as unknown as Record<symbol, unknown>)[Symbol.toPrimitive]).toBeUndefined()
    expect(() => JSON.stringify({ router })).not.toThrow()
  })

  it('does not route the names Object.prototype owns', async () => {
    // Membership was once tested with a bare `Reflect.has`, which keeps walking into
    // `Object.prototype`, so `toString` / `valueOf` / `constructor` / `hasOwnProperty` were all
    // answered with installation-routing functions. Coercing the client then called `toString()`
    // with no arguments: the router read `args[0]` as the installation id, so the coercion got a
    // promise where it needed a primitive AND an unawaited installation read rejected behind it.
    // A logger or a template literal reaching the client is enough to trigger it.
    const { repo, reads } = fakeInstallations([installation(1, 'github')])
    const router = providerRoutingGitHubClient({
      installations: repo,
      github: stubClient('gh').client,
      gitlab: stubClient('gl').client,
    })

    // Asserted over `Object.prototype`'s OWN keys against a PLAIN object rather than a hand-listed
    // few, so a name added to it later is covered without anyone remembering to extend this, and
    // the accessor keys (`__proto__`) compare by what they resolve to rather than by identity.
    const plain = {} as Record<string, unknown>
    const drifted = Object.getOwnPropertyNames(Object.prototype).filter(
      (name) => (router as unknown as Record<string, unknown>)[name] !== plain[name],
    )
    expect(drifted).toEqual([])

    // The observable consequence, which is what actually reached production code.
    expect(() => `${router}`).not.toThrow()
    expect(String(router)).toBe('[object Object]')
    expect(reads()).toBe(0)
  })

  it('keeps an unimplemented optional port method absent while Object.prototype names stay present', () => {
    // The two halves of the target fall-through must not blur together: an optional method
    // nobody implements has to read as ABSENT (callers feature-test with `in` and degrade),
    // while a name every object has must keep reading as present.
    const router = providerRoutingGitHubClient({
      installations: fakeInstallations([]).repo,
      github: stubClient('gh').client,
      gitlab: stubClient('gl').client,
    })
    expect('getBranchProtection' in router).toBe(false)
    expect(router.getBranchProtection).toBeUndefined()
    expect('toString' in router).toBe(true)
    expect('then' in router).toBe(false)
  })
})
