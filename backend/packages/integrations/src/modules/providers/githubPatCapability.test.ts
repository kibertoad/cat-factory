import { describe, expect, it, vi } from 'vitest'
import { probeGitHubPatCapability, type GitHubPatProbeRepo } from './githubPatCapability.js'

// The classification is `githubPatScope.test.ts`. This exercises the part that needs the
// network: which HTTP outcome becomes which check state, and how the fine-grained repository
// probe folds into one push verdict.

const API = 'https://api.github.com'

interface StubRoute {
  status?: number
  scopes?: string | null
  body?: unknown
}

/**
 * A `fetch` that answers `GET /user` from `user` and each `GET /repos/:owner/:name` from `repos`,
 * keyed by `owner/name`. An unlisted repository 404s, which is what GitHub returns for one a
 * token cannot see.
 */
function stubFetch(user: StubRoute, repos: Record<string, StubRoute> = {}) {
  return vi.fn(async (url: string | URL) => {
    const path = String(url).slice(API.length)
    const route = path === '/user' ? user : (repos[path.replace('/repos/', '')] ?? { status: 404 })
    return new Response(JSON.stringify(route.body ?? {}), {
      status: route.status ?? 200,
      headers: route.scopes ? { 'x-oauth-scopes': route.scopes } : {},
    })
  }) as unknown as typeof fetch
}

function request(overrides: { token?: string; linkedRepos?: GitHubPatProbeRepo[] } = {}) {
  return {
    token: overrides.token ?? 'ghp_classic',
    source: 'initiator' as const,
    linkedRepos: overrides.linkedRepos ?? [],
    webUrl: 'https://github.com',
  }
}

describe('probeGitHubPatCapability — the token itself', () => {
  it.each([401, 403])('reports HTTP %i as a rejected token', async (status) => {
    const check = await probeGitHubPatCapability(request(), {
      fetch: stubFetch({ status }),
    })
    expect(check).toEqual({ state: 'token_rejected', status })
  })

  // A 500 says nothing about the credential, and reporting it as one would advertise an
  // expensive, wrong remedy.
  it('reports an upstream 5xx as a failed probe, not a bad token', async () => {
    const check = await probeGitHubPatCapability(request(), { fetch: stubFetch({ status: 503 }) })
    expect(check).toMatchObject({ state: 'probe_failed' })
  })

  it('reports a transport failure as a failed probe rather than throwing', async () => {
    const check = await probeGitHubPatCapability(request(), {
      fetch: vi.fn(async () => {
        throw new Error('connect ETIMEDOUT')
      }) as unknown as typeof fetch,
    })
    expect(check).toEqual({ state: 'probe_failed', message: 'connect ETIMEDOUT' })
  })
})

describe('probeGitHubPatCapability — a classic token', () => {
  it('reads every capability off the reported scopes', async () => {
    const check = await probeGitHubPatCapability(request(), {
      fetch: stubFetch({ scopes: 'repo, workflow' }),
    })
    expect(check).toMatchObject({
      state: 'checked',
      report: {
        kind: 'classic',
        scopes: ['repo', 'workflow'],
        capabilities: { push: 'granted', pullRequests: 'granted', workflows: 'granted' },
      },
    })
  })

  it('calls out a token with no repository write scope at all', async () => {
    const check = await probeGitHubPatCapability(request(), {
      fetch: stubFetch({ scopes: 'read:user, gist' }),
    })
    expect(check).toMatchObject({
      state: 'checked',
      report: { capabilities: { push: 'missing', pullRequests: 'missing', workflows: 'missing' } },
    })
  })

  // `repo` without `workflow` is the recommended-looking token that still cannot edit CI — the
  // advisory case the banner mentions but never opens for.
  it('separates the workflow gap from the blocking ones', async () => {
    const check = await probeGitHubPatCapability(request(), {
      fetch: stubFetch({ scopes: 'repo' }),
    })
    expect(check).toMatchObject({
      state: 'checked',
      report: { capabilities: { push: 'granted', pullRequests: 'granted', workflows: 'missing' } },
    })
  })

  // `public_repo` is enough for a board working entirely in the open and not enough for a private
  // repository, and the scope header cannot tell which this is.
  it('leaves a public-only token unknown rather than guessing either way', async () => {
    const check = await probeGitHubPatCapability(request(), {
      fetch: stubFetch({ scopes: 'public_repo, workflow' }),
    })
    expect(check).toMatchObject({
      state: 'checked',
      report: { capabilities: { push: 'unknown', pullRequests: 'unknown' } },
    })
  })

  // A classic token's scopes answer for every repository at once, so nothing is sampled.
  it('probes no repositories', async () => {
    const doFetch = stubFetch({ scopes: 'repo,workflow' })
    await probeGitHubPatCapability(request({ linkedRepos: [{ owner: 'acme', name: 'api' }] }), {
      fetch: doFetch,
    })
    expect(vi.mocked(doFetch)).toHaveBeenCalledTimes(1)
  })
})

describe('probeGitHubPatCapability — a fine-grained token', () => {
  const FINE = 'github_pat_11ABCDEF'

  it('reads push off the linked repositories and leaves the rest unknown', async () => {
    const check = await probeGitHubPatCapability(
      request({ token: FINE, linkedRepos: [{ owner: 'acme', name: 'api' }] }),
      { fetch: stubFetch({}, { 'acme/api': { body: { permissions: { push: true } } } }) },
    )
    expect(check).toMatchObject({
      state: 'checked',
      report: {
        kind: 'fine_grained',
        capabilities: { push: 'granted', pullRequests: 'unknown', workflows: 'unknown' },
        probedRepos: ['acme/api'],
        unprobedRepoCount: 0,
      },
    })
  })

  // One definitive refusal is enough: the board links a repository whose pipeline is broken.
  it('reports push as missing when any linked repository refuses it', async () => {
    const check = await probeGitHubPatCapability(
      request({
        token: FINE,
        linkedRepos: [
          { owner: 'acme', name: 'api' },
          { owner: 'acme', name: 'web' },
        ],
      }),
      {
        fetch: stubFetch(
          {},
          {
            'acme/api': { body: { permissions: { push: true } } },
            'acme/web': { body: { permissions: { push: false } } },
          },
        ),
      },
    )
    expect(check).toMatchObject({ state: 'checked', report: { capabilities: { push: 'missing' } } })
  })

  // A 404 means "this token cannot see it" and "it no longer exists" alike, so a stale projection
  // row must not be reported to a user as a broken credential.
  it('leaves push unknown when a repository could not be read at all', async () => {
    const check = await probeGitHubPatCapability(
      request({
        token: FINE,
        linkedRepos: [
          { owner: 'acme', name: 'api' },
          { owner: 'acme', name: 'gone' },
        ],
      }),
      { fetch: stubFetch({}, { 'acme/api': { body: { permissions: { push: true } } } }) },
    )
    expect(check).toMatchObject({ state: 'checked', report: { capabilities: { push: 'unknown' } } })
  })

  it('leaves push unknown when the board links nothing to check against', async () => {
    const check = await probeGitHubPatCapability(request({ token: FINE }), {
      fetch: stubFetch({}),
    })
    expect(check).toMatchObject({
      state: 'checked',
      report: { capabilities: { push: 'unknown' }, probedRepos: [], unprobedRepoCount: 0 },
    })
  })

  // The cap is what keeps this cheap on a board load; declaring what it dropped is what keeps a
  // clean verdict from reading as a guarantee.
  it('caps how many repositories it reads and counts the remainder', async () => {
    const linkedRepos = Array.from({ length: 5 }, (_, i) => ({ owner: 'acme', name: `svc${i}` }))
    const check = await probeGitHubPatCapability(request({ token: FINE, linkedRepos }), {
      fetch: stubFetch(
        {},
        Object.fromEntries(
          linkedRepos.map((r) => [`acme/${r.name}`, { body: { permissions: { push: true } } }]),
        ),
      ),
      maxProbedRepos: 2,
    })
    expect(check).toMatchObject({
      state: 'checked',
      report: { probedRepos: ['acme/svc0', 'acme/svc1'], unprobedRepoCount: 3 },
    })
  })

  // An enterprise/older payload we cannot read is not a refusal GitHub made.
  it('treats an unreadable permissions block as unreadable, not as a denial', async () => {
    const check = await probeGitHubPatCapability(
      request({ token: FINE, linkedRepos: [{ owner: 'acme', name: 'api' }] }),
      { fetch: stubFetch({}, { 'acme/api': { body: {} } }) },
    )
    expect(check).toMatchObject({ state: 'checked', report: { capabilities: { push: 'unknown' } } })
  })
})

describe('probeGitHubPatCapability — the report', () => {
  it('carries the source and instance through for the remedy the banner offers', async () => {
    const check = await probeGitHubPatCapability(
      { ...request(), source: 'deployment', webUrl: 'https://ghe.example.com' },
      { fetch: stubFetch({ scopes: 'repo,workflow' }) },
    )
    expect(check).toMatchObject({
      state: 'checked',
      report: { source: 'deployment', webUrl: 'https://ghe.example.com' },
    })
  })
})
