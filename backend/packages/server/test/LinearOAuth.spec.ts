import { afterEach, describe, expect, it, vi } from 'vitest'
import { LinearOAuth } from '../src/auth/LinearOAuth.js'

const oauth = new LinearOAuth({ clientId: 'cid', clientSecret: 'secret' })

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('LinearOAuth.authorizeUrl', () => {
  it('builds the Linear authorize URL with the expected params', () => {
    const url = new URL(
      oauth.authorizeUrl({ redirectUri: 'https://app.test/tasks/oauth/callback', state: 'st' }),
    )
    expect(url.origin + url.pathname).toBe('https://linear.app/oauth/authorize')
    expect(url.searchParams.get('client_id')).toBe('cid')
    expect(url.searchParams.get('redirect_uri')).toBe('https://app.test/tasks/oauth/callback')
    expect(url.searchParams.get('state')).toBe('st')
    expect(url.searchParams.get('response_type')).toBe('code')
    expect(url.searchParams.get('scope')).toBe('read,write')
  })
})

describe('LinearOAuth.exchangeCode', () => {
  it('posts the code form-encoded and returns the access token', async () => {
    const fetchMock = vi.fn(async (_url: string, init: { body: URLSearchParams }) => {
      const params = init.body
      expect(params.get('grant_type')).toBe('authorization_code')
      expect(params.get('code')).toBe('the-code')
      expect(params.get('client_secret')).toBe('secret')
      expect(params.get('redirect_uri')).toBe('https://app.test/tasks/oauth/callback')
      return new Response(JSON.stringify({ access_token: 'tok_123' }), { status: 200 })
    })
    vi.stubGlobal('fetch', fetchMock)

    const token = await oauth.exchangeCode('the-code', 'https://app.test/tasks/oauth/callback')
    expect(token).toBe('tok_123')
    expect(fetchMock).toHaveBeenCalledOnce()
  })

  it('throws when the token endpoint returns a non-OK status', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('nope', { status: 400 })),
    )
    await expect(oauth.exchangeCode('x', 'https://app.test/cb')).rejects.toThrow(/HTTP 400/)
  })

  it('throws when no access token is returned', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ error: 'invalid_grant' }), { status: 200 })),
    )
    await expect(oauth.exchangeCode('x', 'https://app.test/cb')).rejects.toThrow(/invalid_grant/)
  })
})
