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
