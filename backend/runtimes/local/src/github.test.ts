import { describe, expect, it, vi } from 'vitest'
import { createLocalGitHubClient, StaticTokenAppRegistry } from './github.js'

describe('StaticTokenAppRegistry', () => {
  it('returns the PAT for installation tokens and rejects app-JWT use', async () => {
    const reg = new StaticTokenAppRegistry('pat_abc')
    expect(reg.defaultAppId).toBe('')
    expect(reg.apps()).toEqual([{ appId: '' }])
    await expect(reg.installationToken()).resolves.toBe('pat_abc')
    await expect(reg.authForApp().appJwt()).rejects.toThrow(/not available in local/)
  })
})

describe('createLocalGitHubClient', () => {
  it('returns undefined without a PAT', () => {
    expect(createLocalGitHubClient({})).toBeUndefined()
  })

  it('builds a PAT-authenticated client that hits the GitHub API with a Bearer token', async () => {
    const fetchMock = vi.fn(
      async (_input: string | URL | Request, _init?: RequestInit) =>
        new Response(JSON.stringify({ id: 1, sha: 'abc' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    )
    vi.stubGlobal('fetch', fetchMock)
    try {
      const client = createLocalGitHubClient({ GITHUB_PAT: 'pat_xyz' })!
      expect(client).toBeDefined()
      // Any installation-authenticated call should carry the PAT as a bearer token.
      await client.mergePullRequest(123, { owner: 'o', repo: 'r' }, 7)
      const [, init] = fetchMock.mock.calls.at(-1)!
      expect((init as RequestInit).headers).toMatchObject({ authorization: 'Bearer pat_xyz' })
    } finally {
      vi.unstubAllGlobals()
    }
  })
})
