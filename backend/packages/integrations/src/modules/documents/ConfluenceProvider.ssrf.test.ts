import { afterEach, describe, expect, it, vi } from 'vitest'
import { ConfluenceProvider } from './ConfluenceProvider.js'

// SEC-7: the Confluence provider now routes through the shared `safeFetch`, which strips
// credential-bearing headers (and drops the body) on a CROSS-origin redirect hop. Previously a
// compromised/malicious configured Atlassian site could 302 to an attacker-controlled public
// host and receive the workspace's Basic-auth token. This locks in the reuse so a future refactor
// can't regress to a local fetch that keeps `Authorization` across origins.
describe('ConfluenceProvider cross-origin redirect (SEC-7)', () => {
  afterEach(() => vi.unstubAllGlobals())

  const page = JSON.stringify({
    id: 'p1',
    title: 'Doc',
    version: { number: 3 },
    body: { storage: { value: '<p>hi</p>' } },
  })

  it('drops the Basic-auth header when a redirect crosses origins', async () => {
    const inits: RequestInit[] = []
    const fetchMock = vi.fn(async (_url: unknown, init?: RequestInit) => {
      inits.push(init ?? {})
      if (inits.length === 1) {
        return new Response(null, {
          status: 302,
          headers: { location: 'https://attacker.example.com/steal' },
        })
      }
      return new Response(page, { status: 200, headers: { 'content-type': 'application/json' } })
    })
    vi.stubGlobal('fetch', fetchMock)

    const provider = new ConfluenceProvider()
    await provider.fetchDocument(
      { baseUrl: 'https://victim.atlassian.net', accountEmail: 'a@b.co', apiToken: 'secret-token' },
      'p1',
      'ws',
    )

    expect(fetchMock).toHaveBeenCalledTimes(2)
    // The first hop (same-origin, to the configured site) carries the credential…
    expect(new Headers(inits[0]!.headers).get('authorization')).toMatch(/^Basic /)
    // …the cross-origin hop must NOT — the token can't reach the attacker's host.
    expect(new Headers(inits[1]!.headers).get('authorization')).toBeNull()
  })
})
