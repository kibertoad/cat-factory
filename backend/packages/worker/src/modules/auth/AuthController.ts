import { Hono } from 'hono'
import type { Context } from 'hono'
import { getCookie, setCookie, deleteCookie } from 'hono/cookie'
import type { AuthConfig } from '../../infrastructure/config'
import type { AppEnv } from '../../infrastructure/http/types'
import { GitHubOAuth } from '../../infrastructure/auth/GitHubOAuth'
import { HmacSigner, TOKEN_AUDIENCE, type SessionPayload } from '../../infrastructure/auth/signing'
import { verifySession } from '../../infrastructure/auth/middleware'

// "Login with GitHub" endpoints. The browser is bounced to GitHub, comes back to
// /auth/callback, and we hand the SPA a signed session token via the URL
// fragment (kept out of server logs / Referer). The SPA stores it and sends it
// as a bearer token on subsequent API calls. The whole module is inert unless an
// OAuth app + session secret are configured (config.auth.enabled).

const OAUTH_STATE_TTL_MS = 10 * 60 * 1000

/**
 * Browser-binding cookie for the OAuth round-trip. The `state` nonce is mirrored
 * here as an HttpOnly, SameSite=Lax cookie set at `/login`; `/callback` requires
 * the cookie to match the signed state's nonce. This binds the flow to the
 * browser that started it, defeating login-CSRF / session fixation (an attacker
 * who pre-fetches a valid `state` cannot complete it in a victim's browser,
 * which carries no matching cookie). SameSite=Lax still rides the top-level GET
 * navigation back from GitHub.
 */
const OAUTH_STATE_COOKIE = 'cf_oauth_state'

interface OAuthState {
  /** Audience pin — always `oauth-state`. */
  aud: typeof TOKEN_AUDIENCE.oauthState
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
 * Choose the post-login landing URL from the (untrusted) `redirect` query.
 *
 * The session token is appended to this URL as a fragment, so an unrestricted
 * redirect is a token-exfiltration primitive: a crafted
 * `/auth/login?redirect=https://evil.example` would hand a victim's freshly
 * minted session to the attacker. We therefore only honour redirects whose
 * origin is the request's own origin or an explicitly allowlisted one; anything
 * else falls back to the request origin. A fixed `AUTH_SUCCESS_REDIRECT_URL`
 * short-circuits all of this (the recommended production setting).
 */
export function pickPostLoginRedirect(
  requested: string | undefined,
  requestOrigin: string,
  cfg: Pick<AuthConfig, 'successRedirectUrl' | 'allowedRedirectOrigins'>,
): string {
  if (cfg.successRedirectUrl) return cfg.successRedirectUrl
  const fallback = `${requestOrigin}/`
  if (!requested) return fallback
  try {
    const url = new URL(requested)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return fallback
    if (url.origin === requestOrigin || cfg.allowedRedirectOrigins.includes(url.origin)) {
      return requested
    }
  } catch {
    // fall through to the safe origin-relative default
  }
  return fallback
}

/**
 * Resolve where to land the browser after login. The chosen value is sealed into
 * the signed state, so it can't be tampered with between the two legs of the flow.
 */
function resolveRedirect(c: Context<AppEnv>, cfg: AuthConfig): string {
  return pickPostLoginRedirect(c.req.query('redirect'), new URL(c.req.url).origin, cfg)
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

  // Start the flow: redirect to GitHub with a signed state nonce, and mirror that
  // nonce into a browser-bound, HttpOnly cookie so the callback can prove the
  // round-trip finished in the same browser (login-CSRF defence).
  app.get('/login', async (c) => {
    const cfg = authConfig(c)
    if (!cfg.enabled) return unavailable(c)

    const nonce = crypto.randomUUID()
    const state: OAuthState = {
      aud: TOKEN_AUDIENCE.oauthState,
      nonce,
      redirect: resolveRedirect(c, cfg),
      exp: Date.now() + OAUTH_STATE_TTL_MS,
    }
    const signedState = await new HmacSigner(cfg.sessionSecret).sign(state)
    setCookie(c, OAUTH_STATE_COOKIE, nonce, {
      httpOnly: true,
      secure: new URL(c.req.url).protocol === 'https:',
      sameSite: 'Lax',
      path: '/auth',
      maxAge: OAUTH_STATE_TTL_MS / 1000,
    })
    const url = oauthClient(cfg).authorizeUrl({
      redirectUri: callbackUrl(c, cfg),
      state: signedState,
    })
    return c.redirect(url)
  })

  // Finish the flow: verify state, confirm the browser-binding cookie, exchange
  // code, mint a session, hand it back.
  app.get('/callback', async (c) => {
    const cfg = authConfig(c)
    if (!cfg.enabled) return unavailable(c)

    const code = c.req.query('code')
    const signer = new HmacSigner(cfg.sessionSecret)
    const state = await signer.verify<OAuthState>(c.req.query('state'), {
      aud: TOKEN_AUDIENCE.oauthState,
    })
    // Single-use: drop the binding cookie regardless of outcome.
    const boundNonce = getCookie(c, OAUTH_STATE_COOKIE)
    deleteCookie(c, OAUTH_STATE_COOKIE, { path: '/auth' })
    if (!code || !state || !boundNonce || boundNonce !== state.nonce) {
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

    const session: SessionPayload = {
      ...user,
      aud: TOKEN_AUDIENCE.session,
      exp: Date.now() + cfg.sessionTtlMs,
    }
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
