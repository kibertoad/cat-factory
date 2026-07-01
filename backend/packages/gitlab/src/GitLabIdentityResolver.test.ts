import { describe, expect, it } from 'vitest'
import { GitLabIdentityResolver } from './GitLabIdentityResolver.js'

// The PAT-login identity resolver maps GitLab's `GET /api/v4/user` onto the neutral
// VcsIdentity, keyed on the numeric user id (the collision-safe subject). A non-2xx
// response (revoked/invalid token) must throw, so a login never succeeds on a bad token.

function fakeFetch(res: { status?: number; body?: unknown }, captured: { token?: string }) {
  return (async (url: string | URL, init?: RequestInit) => {
    const headers = (init?.headers ?? {}) as Record<string, string>
    captured.token = headers['private-token']
    expect(String(url)).toBe('https://gitlab.com/api/v4/user')
    return new Response(res.body === undefined ? null : JSON.stringify(res.body), {
      status: res.status ?? 200,
      headers: { 'content-type': 'application/json' },
    })
  }) as unknown as typeof fetch
}

describe('GitLabIdentityResolver', () => {
  it('maps the GitLab user onto a neutral identity (numeric id as subject)', async () => {
    const captured: { token?: string } = {}
    const resolver = new GitLabIdentityResolver({
      fetchImpl: fakeFetch(
        {
          body: {
            id: 7,
            username: 'octolab',
            name: 'Octo Lab',
            avatar_url: 'https://gitlab.com/avatar.png',
            email: 'octo@lab.dev',
          },
        },
        captured,
      ),
    })
    const identity = await resolver.resolveIdentity('glpat-xyz')
    expect(captured.token).toBe('glpat-xyz')
    expect(identity).toEqual({
      provider: 'gitlab',
      externalId: '7',
      login: 'octolab',
      name: 'Octo Lab',
      avatarUrl: 'https://gitlab.com/avatar.png',
      email: 'octo@lab.dev',
    })
  })

  it('throws on an invalid token (401)', async () => {
    const resolver = new GitLabIdentityResolver({
      fetchImpl: fakeFetch({ status: 401, body: { message: '401 Unauthorized' } }, {}),
    })
    await expect(resolver.resolveIdentity('bad')).rejects.toThrow(/HTTP 401/)
  })

  describe('resolveOrgs (group-membership admission)', () => {
    it('lists the member groups by lowercased full path, restricted to actual membership', async () => {
      const captured: { url?: string; token?: string } = {}
      const resolver = new GitLabIdentityResolver({
        fetchImpl: (async (url: string | URL, init?: RequestInit) => {
          captured.url = String(url)
          captured.token = ((init?.headers ?? {}) as Record<string, string>)['private-token']
          return new Response(
            JSON.stringify([
              { full_path: 'Acme', path: 'acme' },
              { full_path: 'Acme/Platform', path: 'platform' },
              {}, // a malformed entry is skipped, not crashed on
            ]),
            { status: 200, headers: { 'content-type': 'application/json' } },
          )
        }) as unknown as typeof fetch,
      })
      const orgs = await resolver.resolveOrgs('glpat-xyz')
      // min_access_level=10 (Guest) scopes the listing to groups the user belongs to.
      expect(captured.url).toBe('https://gitlab.com/api/v4/groups?min_access_level=10&per_page=100')
      expect(captured.token).toBe('glpat-xyz')
      expect(orgs).toEqual(['acme', 'acme/platform'])
    })

    it('throws on a non-2xx groups response', async () => {
      const resolver = new GitLabIdentityResolver({
        fetchImpl: (async () =>
          new Response(JSON.stringify({ message: '403 Forbidden' }), {
            status: 403,
            headers: { 'content-type': 'application/json' },
          })) as unknown as typeof fetch,
      })
      await expect(resolver.resolveOrgs('tok')).rejects.toThrow(/HTTP 403/)
    })

    it('follows `Link: rel="next"` pagination and concatenates every page', async () => {
      // A user whose allowlisted group sits on a later page must still be admitted — so the
      // resolver follows the next-link, not just the first 100 groups.
      const urls: string[] = []
      const page2 = 'https://gitlab.com/api/v4/groups?min_access_level=10&per_page=100&page=2'
      const resolver = new GitLabIdentityResolver({
        fetchImpl: (async (url: string | URL) => {
          const u = String(url)
          urls.push(u)
          const first = !u.includes('page=2')
          return new Response(
            JSON.stringify(first ? [{ full_path: 'Acme' }] : [{ full_path: 'Acme/Platform' }]),
            {
              status: 200,
              headers: {
                'content-type': 'application/json',
                // Only the first page advertises a next link.
                ...(first ? { link: `<${page2}>; rel="next"` } : {}),
              },
            },
          )
        }) as unknown as typeof fetch,
      })
      const orgs = await resolver.resolveOrgs('tok')
      expect(urls).toEqual([
        'https://gitlab.com/api/v4/groups?min_access_level=10&per_page=100',
        page2,
      ])
      expect(orgs).toEqual(['acme', 'acme/platform'])
    })

    it('stops at the page cap and warns when there are still more pages', async () => {
      // Every page keeps advertising a next link, so the resolver bounds itself at MAX_PAGES
      // and surfaces the truncation via the injected logger rather than looping unbounded or
      // silently dropping the tail (which would wrongly deny a user on a very late page).
      const warnings: string[] = []
      let calls = 0
      const resolver = new GitLabIdentityResolver({
        logger: { warn: (m) => warnings.push(m) },
        fetchImpl: (async () => {
          calls++
          return new Response(JSON.stringify([{ full_path: `g${calls}` }]), {
            status: 200,
            headers: {
              'content-type': 'application/json',
              link: '<https://gitlab.com/api/v4/groups?min_access_level=10&per_page=100&page=next>; rel="next"',
            },
          })
        }) as unknown as typeof fetch,
      })
      const orgs = await resolver.resolveOrgs('tok')
      expect(calls).toBe(10) // MAX_PAGES
      expect(orgs).toHaveLength(10)
      expect(warnings).toHaveLength(1)
      expect(warnings[0]).toMatch(/truncated at MAX_PAGES/)
    })
  })

  it('targets a self-managed instance base when configured', async () => {
    const resolver = new GitLabIdentityResolver({
      apiBase: 'https://gitlab.example.com/api/v4',
      fetchImpl: (async (url: string | URL) => {
        expect(String(url)).toBe('https://gitlab.example.com/api/v4/user')
        return new Response(JSON.stringify({ id: 1, username: 'u' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }) as unknown as typeof fetch,
    })
    const identity = await resolver.resolveIdentity('tok')
    expect(identity.externalId).toBe('1')
  })
})
