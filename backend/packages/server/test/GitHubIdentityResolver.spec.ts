import { describe, expect, it } from 'vitest'
import { GitHubIdentityResolver } from '../src/github/GitHubIdentityResolver.js'

// The PAT-login identity resolver maps GitHub's `GET /user` onto the neutral VcsIdentity,
// keyed on the numeric user id — the SAME subject the OAuth login path uses, so a PAT login
// and a GitHub OAuth login for the same person resolve to one canonical user. A non-2xx
// (revoked/invalid token) must throw so a login never succeeds on a bad token.

function fakeFetch(res: { status?: number; body?: unknown }, captured: { auth?: string }) {
  return (async (url: string | URL, init?: RequestInit) => {
    const headers = (init?.headers ?? {}) as Record<string, string>
    captured.auth = headers.authorization
    expect(String(url)).toBe('https://api.github.com/user')
    return new Response(res.body === undefined ? null : JSON.stringify(res.body), {
      status: res.status ?? 200,
      headers: { 'content-type': 'application/json' },
    })
  }) as unknown as typeof fetch
}

describe('GitHubIdentityResolver', () => {
  it('maps the GitHub user onto a neutral identity (numeric id as subject)', async () => {
    const captured: { auth?: string } = {}
    const resolver = new GitHubIdentityResolver({
      apiBase: 'https://api.github.com',
      fetchImpl: fakeFetch(
        {
          body: {
            id: 4242,
            login: 'octocat',
            name: 'The Octocat',
            avatar_url: 'https://github.com/avatar.png',
            email: 'octo@cat.dev',
          },
        },
        captured,
      ),
    })
    const identity = await resolver.resolveIdentity('ghp_abc')
    expect(captured.auth).toBe('Bearer ghp_abc')
    expect(identity).toEqual({
      provider: 'github',
      externalId: '4242',
      login: 'octocat',
      name: 'The Octocat',
      avatarUrl: 'https://github.com/avatar.png',
      email: 'octo@cat.dev',
    })
  })

  it('tolerates an account with no public email/name', async () => {
    const resolver = new GitHubIdentityResolver({
      apiBase: 'https://api.github.com',
      fetchImpl: fakeFetch({ body: { id: 1, login: 'ghost' } }, {}),
    })
    const identity = await resolver.resolveIdentity('tok')
    expect(identity).toMatchObject({ externalId: '1', login: 'ghost', name: null, email: null })
  })

  it('throws on an invalid token (401)', async () => {
    const resolver = new GitHubIdentityResolver({
      apiBase: 'https://api.github.com',
      fetchImpl: fakeFetch({ status: 401, body: { message: 'Bad credentials' } }, {}),
    })
    await expect(resolver.resolveIdentity('bad')).rejects.toThrow(/HTTP 401/)
  })
})
