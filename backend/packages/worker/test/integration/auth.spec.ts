import { env } from 'cloudflare:test'
import { describe, expect, it } from 'vitest'
import { createApp } from '../../src/app'
import { HmacSigner, TOKEN_AUDIENCE, type SessionPayload } from '../../src/infrastructure/auth/signing'
import { pickPostLoginRedirect } from '../../src/modules/auth/AuthController'

// Auth is opt-in: it only activates when the OAuth credentials + session secret
// are present in the Worker env. We exercise both states by passing a tailored
// `env` straight to `app.fetch` (config is derived from `c.env` per request), so
// the rest of the suite — which runs with auth unconfigured — is unaffected.

// Must be >= MIN_SESSION_SECRET_LENGTH (32) or auth is treated as misconfigured.
const SECRET = 'test-session-secret-0123456789abcdef'
const BASE = 'https://cat-factory.test'

const authEnv = {
  ...env,
  GITHUB_OAUTH_CLIENT_ID: 'client-id',
  GITHUB_OAUTH_CLIENT_SECRET: 'client-secret',
  AUTH_SESSION_SECRET: SECRET,
}

function fetchWith(
  envOverride: typeof env,
  init: { method?: string; path: string; token?: string },
) {
  const app = createApp()
  const headers = init.token ? { authorization: `Bearer ${init.token}` } : undefined
  return app.fetch(
    new Request(`${BASE}${init.path}`, { method: init.method ?? 'GET', headers }),
    envOverride,
  )
}

function session(overrides: Partial<SessionPayload> = {}): Promise<string> {
  const payload: SessionPayload = {
    aud: TOKEN_AUDIENCE.session,
    id: 42,
    login: 'octocat',
    name: 'The Octocat',
    avatarUrl: 'https://example.com/a.png',
    exp: Date.now() + 60_000,
    ...overrides,
  }
  return new HmacSigner(SECRET).sign(payload)
}

describe('auth', () => {
  describe('HmacSigner', () => {
    it('round-trips a signed payload', async () => {
      const signer = new HmacSigner(SECRET)
      const token = await signer.sign({ id: 1, exp: Date.now() + 1000 })
      expect(await signer.verify<{ id: number }>(token)).toMatchObject({ id: 1 })
    })

    it('rejects a tampered signature', async () => {
      const signer = new HmacSigner(SECRET)
      const token = await signer.sign({ id: 1, exp: Date.now() + 1000 })
      expect(await signer.verify(`${token}x`)).toBeNull()
    })

    it('rejects a different secret', async () => {
      const token = await new HmacSigner(SECRET).sign({ id: 1, exp: Date.now() + 1000 })
      expect(await new HmacSigner('other').verify(token)).toBeNull()
    })

    it('rejects an expired payload', async () => {
      const signer = new HmacSigner(SECRET)
      const token = await signer.sign({ id: 1, exp: Date.now() - 1000 })
      expect(await signer.verify(token)).toBeNull()
    })

    it('returns null (never throws) on a malformed base64url signature', async () => {
      const signer = new HmacSigner(SECRET)
      // The tail after the dot is not valid base64url; decoding must fail closed.
      expect(await signer.verify('eyJpZCI6MX0.@@not-base64@@')).toBeNull()
    })
  })

  describe('pickPostLoginRedirect', () => {
    const origin = 'https://cat-factory.test'

    it('returns a fixed success URL when configured, ignoring the query', () => {
      const url = pickPostLoginRedirect('https://evil.example', origin, {
        successRedirectUrl: 'https://app.example.com/board',
        allowedRedirectOrigins: [],
      })
      expect(url).toBe('https://app.example.com/board')
    })

    it('honours a same-origin redirect', () => {
      const url = pickPostLoginRedirect(`${origin}/board`, origin, {
        successRedirectUrl: '',
        allowedRedirectOrigins: [],
      })
      expect(url).toBe(`${origin}/board`)
    })

    it('honours an allowlisted cross-origin redirect', () => {
      const url = pickPostLoginRedirect('https://app.example.com/x', origin, {
        successRedirectUrl: '',
        allowedRedirectOrigins: ['https://app.example.com'],
      })
      expect(url).toBe('https://app.example.com/x')
    })

    it('rejects an unlisted cross-origin redirect (no token leak)', () => {
      const url = pickPostLoginRedirect('https://evil.example/steal', origin, {
        successRedirectUrl: '',
        allowedRedirectOrigins: ['https://app.example.com'],
      })
      expect(url).toBe(`${origin}/`)
    })

    it('rejects a non-http(s) redirect scheme', () => {
      const url = pickPostLoginRedirect('javascript:alert(1)', origin, {
        successRedirectUrl: '',
        allowedRedirectOrigins: [],
      })
      expect(url).toBe(`${origin}/`)
    })

    it('falls back to the request origin for a malformed redirect', () => {
      const url = pickPostLoginRedirect('not a url', origin, {
        successRedirectUrl: '',
        allowedRedirectOrigins: [],
      })
      expect(url).toBe(`${origin}/`)
    })
  })

  describe('config gating', () => {
    it('reports disabled when no OAuth app is configured', async () => {
      const res = await fetchWith(env, { path: '/auth/config' })
      expect(res.status).toBe(200)
      expect(await res.json()).toEqual({ enabled: false })
    })

    it('reports enabled once configured', async () => {
      const res = await fetchWith(authEnv, { path: '/auth/config' })
      expect(await res.json()).toEqual({ enabled: true })
    })

    it('leaves the API open when auth is unconfigured but AUTH_DEV_OPEN is set', async () => {
      // The base test env sets AUTH_DEV_OPEN=true (mirrors local `.dev.vars`).
      const res = await fetchWith(env, { path: '/workspaces' })
      expect(res.status).toBe(200)
    })

    it('fails closed (503) when auth is unconfigured and AUTH_DEV_OPEN is unset', async () => {
      // Production shape: no OAuth creds, no dev-open hatch. The gate must refuse
      // rather than serve protected data openly.
      const closedEnv = { ...env, AUTH_DEV_OPEN: undefined } as typeof env
      const res = await fetchWith(closedEnv, { path: '/workspaces' })
      expect(res.status).toBe(503)
      const body = (await res.json()) as { error: { code: string } }
      expect(body.error.code).toBe('auth_not_configured')
    })

    it('keeps /health public even with auth enabled', async () => {
      const res = await fetchWith(authEnv, { path: '/health' })
      expect(res.status).toBe(200)
    })
  })

  describe('protected API', () => {
    it('rejects an unauthenticated request with 401', async () => {
      const res = await fetchWith(authEnv, { path: '/workspaces' })
      expect(res.status).toBe(401)
    })

    it('rejects an expired token', async () => {
      const token = await session({ exp: Date.now() - 1000 })
      const res = await fetchWith(authEnv, { path: '/workspaces', token })
      expect(res.status).toBe(401)
    })

    it('allows a valid session', async () => {
      const token = await session()
      const res = await fetchWith(authEnv, { path: '/workspaces', token })
      expect(res.status).toBe(200)
    })
  })

  describe('login + me', () => {
    it('redirects to GitHub with a signed state', async () => {
      const res = await fetchWith(authEnv, { path: '/auth/login?redirect=https://app.example.com' })
      expect(res.status).toBe(302)
      const location = new URL(res.headers.get('location')!)
      expect(location.origin).toBe('https://github.com')
      expect(location.pathname).toBe('/login/oauth/authorize')
      expect(location.searchParams.get('client_id')).toBe('client-id')
      expect(location.searchParams.get('state')).toBeTruthy()
      expect(location.searchParams.get('redirect_uri')).toBe(`${BASE}/auth/callback`)
    })

    it('returns the user for /auth/me with a valid token', async () => {
      const token = await session()
      const res = await fetchWith(authEnv, { path: '/auth/me', token })
      expect(res.status).toBe(200)
      expect(await res.json()).toEqual({
        user: {
          id: 42,
          login: 'octocat',
          name: 'The Octocat',
          avatarUrl: 'https://example.com/a.png',
        },
        enabled: true,
      })
    })

    it('401s on /auth/me without a token', async () => {
      const res = await fetchWith(authEnv, { path: '/auth/me' })
      expect(res.status).toBe(401)
    })
  })
})
