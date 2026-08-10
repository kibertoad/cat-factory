import { describe, expect, it, vi } from 'vitest'
import { probeGitHubPatCapability, type GitHubPatProbeRepo } from './githubPatCapability.js'

// The classification is `githubPatScope.test.ts`. This exercises the part that needs the
// network: which HTTP outcome becomes which check state, and how the fine-grained repository
// probe folds into one push verdict.

const API = 'https://api.github.com'

interface StubRoute {
  status?: number
  /**
   * The `x-oauth-scopes` value. `undefined` sends NO header (a fine-grained token); `''` sends
   * the header empty, which is what GitHub does for a classic token minted with nothing ticked
   * and is a different fact the classifier has to keep apart.
   */
  scopes?: string
  body?: unknown
  headers?: Record<string, string>
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
      headers: {
        ...(route.scopes === undefined ? {} : { 'x-oauth-scopes': route.scopes }),
        ...route.headers,
      },
    })
  }) as unknown as typeof fetch
}

function request(overrides: { token?: string; targetRepos?: GitHubPatProbeRepo[] } = {}) {
  return {
    token: overrides.token ?? 'ghp_classic',
    source: 'initiator' as const,
    targetRepos: overrides.targetRepos ?? [],
    webUrl: 'https://github.com',
  }
}

describe('probeGitHubPatCapability — the token itself', () => {
  it.each([401, 403])('reports HTTP %i as a rejected token', async (status) => {
    const check = await probeGitHubPatCapability(request(), {
      fetch: stubFetch({ status }),
    })
    expect(check).toEqual({ state: 'token_rejected', status, source: 'initiator' })
  })

  // A rejected token produces no report, so `source` has to ride the state itself: it is the one
  // state in which the reader most needs to be told WHOSE credential this is, and the only one
  // with no report to carry it.
  it('names whose credential was rejected', async () => {
    const check = await probeGitHubPatCapability(
      { ...request(), source: 'deployment' },
      { fetch: stubFetch({ status: 401 }) },
    )
    expect(check).toMatchObject({ state: 'token_rejected', source: 'deployment' })
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

  // GitHub spells an exhausted rate limit with the SAME 403 it uses to reject a credential. Read
  // as a rejection, a throttled board load raises the loudest banner the product has and tells
  // the reader to mint a replacement, which is both wrong and expensive.
  it.each([
    ['a spent primary limit', 403, { 'x-ratelimit-remaining': '0' }],
    ['a tripped secondary limit', 403, { 'retry-after': '60' }],
    ['an explicit 429', 429, {}],
  ])('reports %s as a failed probe, not a rejected token', async (_case, status, headers) => {
    const check = await probeGitHubPatCapability(request(), {
      fetch: stubFetch({ status, headers }),
    })
    expect(check).toMatchObject({ state: 'probe_failed' })
  })

  // The remaining-quota header rides EVERY answer, so a healthy one must not read as throttled.
  it('does not mistake a token with quota left for a throttled one', async () => {
    const check = await probeGitHubPatCapability(request(), {
      fetch: stubFetch({ status: 403, headers: { 'x-ratelimit-remaining': '4321' } }),
    })
    expect(check).toMatchObject({ state: 'token_rejected' })
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

  // A classic token minted with nothing ticked still authenticates, and GitHub reports it with a
  // PRESENT, EMPTY scope header. Read as an absent one it classified as `unknown`, took the
  // fine-grained code path, and came back clean off a repository read its OWNER could satisfy.
  it('reports a classic token with no scopes as missing everything', async () => {
    const doFetch = stubFetch(
      { scopes: '' },
      { 'acme/api': { body: { permissions: { push: true } } } },
    )
    const check = await probeGitHubPatCapability(
      request({ targetRepos: [{ owner: 'acme', name: 'api' }] }),
      { fetch: doFetch },
    )
    expect(check).toMatchObject({
      state: 'checked',
      report: {
        kind: 'classic',
        capabilities: { push: 'missing', pullRequests: 'missing', workflows: 'missing' },
      },
    })
    // And it never reaches the repository whose owner-role answer would have masked the gap.
    expect(vi.mocked(doFetch)).toHaveBeenCalledTimes(1)
  })

  // A classic token's scopes answer for every repository at once, so nothing is sampled.
  it('probes no repositories', async () => {
    const doFetch = stubFetch({ scopes: 'repo,workflow' })
    await probeGitHubPatCapability(request({ targetRepos: [{ owner: 'acme', name: 'api' }] }), {
      fetch: doFetch,
    })
    expect(vi.mocked(doFetch)).toHaveBeenCalledTimes(1)
  })
})

describe('probeGitHubPatCapability — a fine-grained token', () => {
  const FINE = 'github_pat_11ABCDEF'

  // `permissions.push` reports the IDENTITY's role, and a token's grants are a subset of its
  // owner's — so a positive there fails to refute the token rather than establishing it. A
  // `contents: read` token on a repository its owner maintains reports exactly this.
  it('does not read the owner role as proof the token may push', async () => {
    const check = await probeGitHubPatCapability(
      request({ token: FINE, targetRepos: [{ owner: 'acme', name: 'api' }] }),
      { fetch: stubFetch({}, { 'acme/api': { body: { permissions: { push: true } } } }) },
    )
    expect(check).toMatchObject({
      state: 'checked',
      report: {
        kind: 'fine_grained',
        capabilities: { push: 'unknown', pullRequests: 'unknown', workflows: 'unknown' },
        probedRepos: ['acme/api'],
        deniedRepos: [],
        unprobedRepoCount: 0,
      },
    })
  })

  // The reverse direction IS conclusive: the owner cannot push, so nothing acting as them can.
  it('reports push as missing when any targeted repository refuses the identity', async () => {
    const check = await probeGitHubPatCapability(
      request({
        token: FINE,
        targetRepos: [
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

  // The headline failure: a fine-grained token pointed at the wrong repositories. `GET /user`
  // already succeeded, so the token authenticates and GitHub is answering; a 404 on every
  // repository the board's services target is the token's repository selection, not a board
  // whose repositories all vanished at once.
  it('reports push as missing when every targeted repository is denied', async () => {
    const check = await probeGitHubPatCapability(
      request({
        token: FINE,
        targetRepos: [
          { owner: 'acme', name: 'api' },
          { owner: 'acme', name: 'web' },
        ],
      }),
      { fetch: stubFetch({}) },
    )
    expect(check).toMatchObject({
      state: 'checked',
      report: {
        capabilities: { push: 'missing' },
        deniedRepos: ['acme/api', 'acme/web'],
      },
    })
  })

  // One 404 among readable repositories stays ambiguous between "not in this token's selection"
  // and a projection row pointing at a renamed repository, and a stale row must not be reported
  // as a broken credential.
  it('leaves push unknown when only some repositories are denied', async () => {
    const check = await probeGitHubPatCapability(
      request({
        token: FINE,
        targetRepos: [
          { owner: 'acme', name: 'api' },
          { owner: 'acme', name: 'gone' },
        ],
      }),
      { fetch: stubFetch({}, { 'acme/api': { body: { permissions: { push: true } } } }) },
    )
    expect(check).toMatchObject({
      state: 'checked',
      report: { capabilities: { push: 'unknown' }, deniedRepos: ['acme/gone'] },
    })
  })

  // A 5xx on the repository read establishes nothing, so it must not join the denied set and
  // turn an outage into a verdict about the token's repository selection.
  it('does not treat an unreadable repository as a denial', async () => {
    const check = await probeGitHubPatCapability(
      request({ token: FINE, targetRepos: [{ owner: 'acme', name: 'api' }] }),
      { fetch: stubFetch({}, { 'acme/api': { status: 500 } }) },
    )
    expect(check).toMatchObject({
      state: 'checked',
      report: { capabilities: { push: 'unknown' }, deniedRepos: [] },
    })
  })

  it('leaves push unknown when the board targets nothing to check against', async () => {
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
    const targetRepos = Array.from({ length: 5 }, (_, i) => ({ owner: 'acme', name: `svc${i}` }))
    const check = await probeGitHubPatCapability(request({ token: FINE, targetRepos }), {
      fetch: stubFetch(
        {},
        Object.fromEntries(
          targetRepos.map((r) => [`acme/${r.name}`, { body: { permissions: { push: true } } }]),
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
      request({ token: FINE, targetRepos: [{ owner: 'acme', name: 'api' }] }),
      { fetch: stubFetch({}, { 'acme/api': { body: {} } }) },
    )
    expect(check).toMatchObject({
      state: 'checked',
      report: { capabilities: { push: 'unknown' }, deniedRepos: [] },
    })
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

  // The one source whose scopes this endpoint could expose is a SHARED operational credential,
  // on a route that lets every member's read through. Nothing renders the list, so it is not on
  // the wire at all rather than being withheld case by case.
  it('does not put the token’s scope list on the wire', async () => {
    const check = await probeGitHubPatCapability(request(), {
      fetch: stubFetch({ scopes: 'repo, workflow, admin:org' }),
    })
    expect(check.state).toBe('checked')
    expect(JSON.stringify(check)).not.toContain('admin:org')
  })
})
