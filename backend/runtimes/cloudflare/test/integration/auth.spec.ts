import { env } from 'cloudflare:test'
import { describe, expect, it } from 'vitest'
import { createApp } from '../../src/app'
import {
  HmacSigner,
  TOKEN_AUDIENCE,
  type SessionPayload,
} from '../../src/infrastructure/auth/signing'
import { FakeAgentExecutor } from '../fakes/FakeAgentExecutor'

// Auth is opt-in: it only activates when the OAuth credentials + session secret
// are present in the Worker env. We exercise both states by passing a tailored
// `env` straight to `app.fetch` (config is derived from `c.env` per request), so
// the rest of the suite — which runs with auth unconfigured — is unaffected.
//
// The pure-logic checks for HmacSigner and pickPostLoginRedirect live in
// @cat-factory/server's unit suite (they're re-exported shims here); this file keeps
// only the worker-wiring integration: config gating, the gate, and the OAuth flow.
// `HmacSigner` is still used below purely to mint session tokens for those tests.

// Must be >= MIN_SESSION_SECRET_LENGTH (32) or auth is treated as misconfigured.
const SECRET = 'test-session-secret-0123456789abcdef'
const BASE = 'https://cat-factory.test'

const authEnv = {
  ...env,
  GITHUB_OAUTH_CLIENT_ID: 'client-id',
  GITHUB_OAUTH_CLIENT_SECRET: 'client-secret',
  AUTH_SESSION_SECRET: SECRET,
}

// The Worker facade always advertises the same infrastructure capabilities
// (it auto-routes execution to a registered pool, else Cloudflare Containers).
const INFRASTRUCTURE = {
  execution: {
    active: 'cloudflare-containers',
    available: ['cloudflare-containers', 'runner-pool'],
  },
  testEnv: {
    active: 'environment-provider',
    available: ['environment-provider'],
  },
  // The Worker serves only the self-contained UI-test container, so a browsable preview is off.
  frontendPreview: { supported: false },
  // The hosted Worker facade governs the account-wide model-family policy.
  modelPolicy: { supported: true },
}

function fetchWith(
  envOverride: typeof env,
  init: { method?: string; path: string; token?: string },
) {
  const app = createApp({ overrides: { agentExecutor: new FakeAgentExecutor() } })
  const headers = init.token ? { authorization: `Bearer ${init.token}` } : undefined
  return app.fetch(
    new Request(`${BASE}${init.path}`, { method: init.method ?? 'GET', headers }),
    envOverride,
  )
}

function session(overrides: Partial<SessionPayload> = {}): Promise<string> {
  const payload: SessionPayload = {
    aud: TOKEN_AUDIENCE.session,
    id: 'usr_42',
    login: 'octocat',
    name: 'The Octocat',
    avatarUrl: 'https://example.com/a.png',
    exp: Date.now() + 60_000,
    ...overrides,
  }
  return new HmacSigner(SECRET).sign(payload)
}

describe('auth', () => {
  describe('config gating', () => {
    it('reports disabled when no OAuth app is configured', async () => {
      const res = await fetchWith(env, { path: '/auth/config' })
      expect(res.status).toBe(200)
      expect(await res.json()).toEqual({
        enabled: false,
        providers: { github: false, password: false, google: false },
        // Hosted PAT login is always offered for GitHub (a user pastes their own PAT); it is
        // independent of the OAuth app being configured.
        patLogin: { providers: ['github'] },
        infrastructure: INFRASTRUCTURE,
      })
    })

    it('reports enabled once configured', async () => {
      const res = await fetchWith(authEnv, { path: '/auth/config' })
      expect(await res.json()).toEqual({
        enabled: true,
        providers: { github: true, password: false, google: false },
        patLogin: { providers: ['github'] },
        infrastructure: INFRASTRUCTURE,
      })
    })

    it('advertises GitLab PAT login when a GitLab connection is configured', async () => {
      // A GitLab-only (or GitHub+GitLab) Worker deployment must let a GitLab user sign in with
      // their own PAT — the hosted analogue of local mode's configured GITLAB_PAT. Setting
      // GITLAB_TOKEN enables the provider, so it joins the advertised PAT-login providers.
      const res = await fetchWith({ ...authEnv, GITLAB_TOKEN: 'glpat-test-token' } as typeof env, {
        path: '/auth/config',
      })
      expect(await res.json()).toEqual({
        enabled: true,
        providers: { github: true, password: false, google: false },
        patLogin: { providers: ['github', 'gitlab'] },
        infrastructure: INFRASTRUCTURE,
      })
    })

    it('advertises testingNoAuth when TESTING_NO_AUTH is set (SPA renders anonymously)', async () => {
      const res = await fetchWith(
        { ...env, TESTING_NO_AUTH: 'true', ENVIRONMENT: 'test' } as typeof env,
        { path: '/auth/config' },
      )
      expect(await res.json()).toEqual({
        enabled: false,
        providers: { github: false, password: false, google: false },
        patLogin: { providers: ['github'] },
        testingNoAuth: true,
        infrastructure: INFRASTRUCTURE,
      })
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

    it('requests only read:user scope when no org allowlist is set', async () => {
      const res = await fetchWith(authEnv, { path: '/auth/login' })
      const location = new URL(res.headers.get('location')!)
      expect(location.searchParams.get('scope')).toBe('read:user')
    })

    it('requests read:org scope when an org allowlist is set', async () => {
      // Org membership must be read from GitHub at callback, which needs the
      // read:org scope to be granted on the user token.
      const orgEnv = { ...authEnv, AUTH_ALLOWED_ORGS: 'my-org' } as typeof env
      const res = await fetchWith(orgEnv, { path: '/auth/login' })
      const location = new URL(res.headers.get('location')!)
      expect(location.searchParams.get('scope')).toBe('read:user read:org')
    })

    it('returns the user for /auth/me with a valid token', async () => {
      const token = await session()
      const res = await fetchWith(authEnv, { path: '/auth/me', token })
      expect(res.status).toBe(200)
      expect(await res.json()).toEqual({
        user: {
          id: 'usr_42',
          login: 'octocat',
          name: 'The Octocat',
          avatarUrl: 'https://example.com/a.png',
          email: null,
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
