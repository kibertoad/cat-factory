import { describe, expect, it, vi } from 'vitest'
import { GoogleOAuth } from '../src/auth/GoogleOAuth.js'

// The endpoints are hand-written rather than SDK-mediated, and nothing in CI can see Google move
// one: a typecheck passes, the fakes pass, and the failure arrives as a broken sign-in. These pin
// them against Google's published discovery document (read 2026-08-18).
describe('GoogleOAuth endpoints', () => {
  const oauth = new GoogleOAuth({ clientId: 'cid', clientSecret: 'secret' })

  it('authorizes at the published authorization_endpoint', () => {
    const url = new URL(oauth.authorizeUrl({ redirectUri: 'https://app.test/cb', state: 'st' }))
    expect(`${url.origin}${url.pathname}`).toBe('https://accounts.google.com/o/oauth2/v2/auth')
    expect(url.searchParams.get('scope')).toBe('openid email profile')
  })

  it('reads userinfo from openidconnect.googleapis.com, the host discovery publishes', async () => {
    const seen: string[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: unknown) => {
        seen.push(String(url))
        return new Response(
          JSON.stringify({ sub: 'g-1', email: 'a@b.co', email_verified: 'true' }),
          {
            status: 200,
            headers: { 'content-type': 'application/json' },
          },
        )
      }),
    )

    const identity = await oauth.fetchUser('token')

    // `www.googleapis.com/oauth2/v3/userinfo`, which this used to call, appears in no current
    // Google page: neither documented as live nor announced as retired.
    expect(seen).toEqual(['https://openidconnect.googleapis.com/v1/userinfo'])
    // Google sends `email_verified` as a boolean or as the STRING "true" depending on the flow,
    // and the verified flag gates the domain allow-list and account linking.
    expect(identity).toMatchObject({ subject: 'g-1', email: 'a@b.co', emailVerified: true })
    vi.unstubAllGlobals()
  })
})
