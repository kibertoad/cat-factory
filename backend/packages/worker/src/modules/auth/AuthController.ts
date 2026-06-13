import { Hono } from 'hono'
import type { Context } from 'hono'
import type { AuthConfig } from '../../infrastructure/config'
import type { AppEnv } from '../../infrastructure/http/types'
import { GitHubOAuth } from '../../infrastructure/auth/GitHubOAuth'
import { HmacSigner, type SessionPayload } from '../../infrastructure/auth/signing'
import { verifySession } from '../../infrastructure/auth/middleware'

// "Login with GitHub" endpoints. The browser is bounced to GitHub, comes back to
// /auth/callback, and we hand the SPA a signed session token via the URL
// fragment (kept out of server logs / Referer). The SPA stores it and sends it
// as a bearer token on subsequent API calls. The whole module is inert unless an
// OAuth app + session secret are configured (config.auth.enabled).

const OAUTH_STATE_TTL_MS = 10 * 60 * 1000

interface OAuthState {
  nonce: string
  /** Where to send the browser (with the token) after a successful login. */
  redirect: string
  exp: number
}

const unavailable = (c: Context<AppEnv>) =>
  c.json({ error: { code: 'unavailable', message: 'Authentication is not configured' } }, 503)

function authConfig(c: Context<AppEnv>): AuthConfig {
  return c.get('container').config.auth
}

function oauthClient(cfg: AuthConfig): GitHubOAuth {
  return new GitHubOAuth({
    clientId: cfg.clientId,
    clientSecret: cfg.clientSecret,
    apiBase: cfg.apiBase,
    oauthBase: cfg.oauthBase,
  })
}

/** The OAuth `redirect_uri` GitHub calls back — must match between the two legs. */
function callbackUrl(c: Context<AppEnv>, cfg: AuthConfig): string {
  if (cfg.callbackUrl) return cfg.callbackUrl
  return `${new URL(c.req.url).origin}/auth/callback`
}

/**
 * Resolve where to land the browser after login. A fixed `AUTH_SUCCESS_REDIRECT_URL`
 * wins (the safe production setting); otherwise we honour the SPA-provided
 * `redirect` query (dev convenience), falling back to the request origin. The
 * chosen value is sealed into the signed state, so it can't be tampered with
 * between the two legs of the flow.
 */
function resolveRedirect(c: Context<AppEnv>, cfg: AuthConfig): string {
  if (cfg.successRedirectUrl) return cfg.successRedirectUrl
  const requested = c.req.query('redirect')
  if (requested) {
    try {
      const url = new URL(requested)
      if (url.protocol === 'http:' || url.protocol === 'https:') return requested
    } catch {
      // fall through to origin
    }
  }
  return `${new URL(c.req.url).origin}/`
}

/** Append the session token as a URL fragment on the landing URL. */
function withToken(redirect: string, token: string): string {
  const url = new URL(redirect)
  url.hash = `token=${token}`
  return url.toString()
}

export function authController(): Hono<AppEnv> {
  const app = new Hono<AppEnv>()

  // Lets the SPA decide whether to show a login gate at all.
  app.get('/config', (c) => c.json({ enabled: authConfig(c).enabled }))

  // Start the flow: redirect to GitHub with a signed state nonce.
  app.get('/login', async (c) => {
    const cfg = authConfig(c)
    if (!cfg.enabled) return unavailable(c)

    const state: OAuthState = {
      nonce: crypto.randomUUID(),
      redirect: resolveRedirect(c, cfg),
      exp: Date.now() + OAUTH_STATE_TTL_MS,
    }
    const signedState = await new HmacSigner(cfg.sessionSecret).sign(state)
    const url = oauthClient(cfg).authorizeUrl({
      redirectUri: callbackUrl(c, cfg),
      state: signedState,
    })
    return c.redirect(url)
  })

  // Finish the flow: verify state, exchange code, mint a session, hand it back.
  app.get('/callback', async (c) => {
    const cfg = authConfig(c)
    if (!cfg.enabled) return unavailable(c)

    const code = c.req.query('code')
    const signer = new HmacSigner(cfg.sessionSecret)
    const state = await signer.verify<OAuthState>(c.req.query('state'))
    if (!code || !state) {
      return c.json({ error: { code: 'validation', message: 'Invalid OAuth callback' } }, 400)
    }

    const oauth = oauthClient(cfg)
    const accessToken = await oauth.exchangeCode(code, callbackUrl(c, cfg))
    const user = await oauth.fetchUser(accessToken)

    // Optional allowlist — keeps the deployment private to known GitHub users.
    if (cfg.allowedLogins.length > 0 && !cfg.allowedLogins.includes(user.login.toLowerCase())) {
      return c.json(
        { error: { code: 'forbidden', message: `@${user.login} is not allowed to sign in` } },
        403,
      )
    }

    const session: SessionPayload = { ...user, exp: Date.now() + cfg.sessionTtlMs }
    const token = await signer.sign(session)
    return c.redirect(withToken(state.redirect, token))
  })

  // Who am I? Used by the SPA to validate a stored token on boot.
  app.get('/me', async (c) => {
    if (!authConfig(c).enabled) return c.json({ user: null, enabled: false })
    const user = await verifySession(c)
    if (!user) {
      return c.json({ error: { code: 'unauthorized', message: 'Not authenticated' } }, 401)
    }
    return c.json({
      user: { id: user.id, login: user.login, name: user.name, avatarUrl: user.avatarUrl },
      enabled: true,
    })
  })

  // Stateless sessions: logout is a client-side token drop. Provided for symmetry.
  app.post('/logout', (c) => c.body(null, 204))

  return app
}
