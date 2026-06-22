import { passwordLoginSchema, signupSchema } from '@cat-factory/contracts'
import { Hono } from 'hono'
import type { Context } from 'hono'
import { deleteCookie, getCookie, setCookie } from 'hono/cookie'
import { GitHubOAuth } from '../../auth/GitHubOAuth.js'
import { GoogleOAuth } from '../../auth/GoogleOAuth.js'
import { verifySession } from '../../auth/middleware.js'
import { HmacSigner, type SessionPayload, type SessionUser, TOKEN_AUDIENCE } from '../../auth/signing.js'
import type { AuthConfig } from '../../config/types.js'
import type { AppEnv } from '../../http/env.js'
import { jsonBody } from '../../http/validation.js'
import type { UserRecord } from '@cat-factory/kernel'
import { ConflictError, ValidationError } from '@cat-factory/kernel'

// Authentication endpoints. The SPA is handed a signed session token (via the URL
// fragment for OAuth redirects, or the JSON body for password login) which it carries
// as `Authorization: Bearer` on subsequent calls. Three login providers compose here:
//   - GitHub OAuth (browser round-trip)
//   - Google OAuth (browser round-trip)
//   - email/password (direct JSON)
// All resolve to ONE canonical `users` row via the UserService, so the session id is
// always the internal `usr_*` id regardless of how the user signed in.

const OAUTH_STATE_TTL_MS = 10 * 60 * 1000

/** Browser-binding cookie for an OAuth round-trip (see the GitHub flow notes below). */
const OAUTH_STATE_COOKIE = 'cf_oauth_state'

interface OAuthState {
  aud: typeof TOKEN_AUDIENCE.oauthState
  nonce: string
  /** Where to send the browser (with the token) after a successful login. */
  redirect: string
  /** Optional invite token to redeem after a brand-new Google/GitHub signup. */
  invite?: string
  exp: number
}

const unavailable = (c: Context<AppEnv>) =>
  c.json({ error: { code: 'unavailable', message: 'Authentication is not configured' } }, 503)

function authConfig(c: Context<AppEnv>): AuthConfig {
  return c.get('container').config.auth
}

function githubClient(cfg: AuthConfig): GitHubOAuth {
  return new GitHubOAuth({
    clientId: cfg.clientId,
    clientSecret: cfg.clientSecret,
    apiBase: cfg.apiBase,
    oauthBase: cfg.oauthBase,
  })
}

function googleClient(cfg: AuthConfig): GoogleOAuth | null {
  if (!cfg.google) return null
  return new GoogleOAuth({
    clientId: cfg.google.clientId,
    clientSecret: cfg.google.clientSecret,
    oauthBase: cfg.google.oauthBase,
    apiBase: cfg.google.apiBase,
  })
}

function githubCallbackUrl(c: Context<AppEnv>, cfg: AuthConfig): string {
  if (cfg.callbackUrl) return cfg.callbackUrl
  return `${new URL(c.req.url).origin}/auth/callback`
}

function googleCallbackUrl(c: Context<AppEnv>, cfg: AuthConfig): string {
  if (cfg.google?.redirectUrl) return cfg.google.redirectUrl
  return `${new URL(c.req.url).origin}/auth/google/callback`
}

/**
 * Choose the post-login landing URL from the (untrusted) `redirect` query. The
 * session token is appended as a fragment, so an unrestricted redirect is a
 * token-exfiltration primitive — only same-origin or explicitly allowlisted origins
 * are honoured, else the request origin.
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

function resolveRedirect(c: Context<AppEnv>, cfg: AuthConfig): string {
  return pickPostLoginRedirect(c.req.query('redirect'), new URL(c.req.url).origin, cfg)
}

/** Append the session token as a URL fragment on the landing URL. */
function withToken(redirect: string, token: string): string {
  const url = new URL(redirect)
  url.hash = `token=${token}`
  return url.toString()
}

/** Build the SessionUser surface from a canonical user + chosen display login. */
function sessionUser(user: UserRecord, login: string): SessionUser {
  return {
    id: user.id,
    login,
    name: user.name,
    avatarUrl: user.avatarUrl,
    email: user.email,
  }
}

async function mintSession(cfg: AuthConfig, user: SessionUser): Promise<string> {
  const session: SessionPayload = {
    ...user,
    aud: TOKEN_AUDIENCE.session,
    exp: Date.now() + cfg.sessionTtlMs,
  }
  return new HmacSigner(cfg.sessionSecret).sign(session)
}

/** Whether an email's domain is on the self-signup allowlist. */
function emailDomainAllowed(email: string, cfg: AuthConfig): boolean {
  const at = email.lastIndexOf('@')
  if (at < 0) return false
  const domain = email.slice(at + 1).toLowerCase()
  return cfg.allowedEmailDomains.includes(domain)
}

/**
 * GitHub allowlist gate — the deployment is private. A user is admitted only if their
 * login is in `allowedLogins` OR they belong to an org in `allowedOrgs`. Both lists
 * empty ⇒ deny everyone (fail closed).
 */
async function isGitHubSignInAllowed(
  oauth: GitHubOAuth,
  accessToken: string,
  user: { login: string },
  cfg: Pick<AuthConfig, 'allowedLogins' | 'allowedOrgs'>,
): Promise<boolean> {
  if (cfg.allowedLogins.includes(user.login.toLowerCase())) return true
  if (cfg.allowedOrgs.length === 0) return false
  const orgs = await oauth.fetchUserOrgs(accessToken)
  return orgs.some((org) => cfg.allowedOrgs.includes(org))
}

export function authController(): Hono<AppEnv> {
  const app = new Hono<AppEnv>()

  // Lets the SPA decide which login controls to show.
  app.get('/config', (c) => {
    const cfg = authConfig(c)
    return c.json({
      enabled: cfg.enabled,
      providers: {
        github: cfg.githubEnabled,
        password: cfg.passwordEnabled,
        google: !!cfg.google,
      },
    })
  })

  // ---- GitHub OAuth -------------------------------------------------------

  app.get('/login', async (c) => {
    const cfg = authConfig(c)
    if (!cfg.githubEnabled) return unavailable(c)
    const nonce = crypto.randomUUID()
    const state: OAuthState = {
      aud: TOKEN_AUDIENCE.oauthState,
      nonce,
      redirect: resolveRedirect(c, cfg),
      ...(c.req.query('invite') ? { invite: c.req.query('invite') } : {}),
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
    const url = githubClient(cfg).authorizeUrl({
      redirectUri: githubCallbackUrl(c, cfg),
      state: signedState,
      scope: cfg.allowedOrgs.length > 0 ? 'read:user read:org' : 'read:user',
    })
    return c.redirect(url)
  })

  app.get('/callback', async (c) => {
    const cfg = authConfig(c)
    if (!cfg.githubEnabled) return unavailable(c)
    const state = await consumeState(c, cfg)
    const code = c.req.query('code')
    if (!code || !state) {
      return c.json({ error: { code: 'validation', message: 'Invalid OAuth callback' } }, 400)
    }
    const oauth = githubClient(cfg)
    const accessToken = await oauth.exchangeCode(code, githubCallbackUrl(c, cfg))
    const identity = await oauth.fetchUser(accessToken)

    const container = c.get('container')
    // An invite OR the allowlist admits the user. A signed invite token short-circuits
    // the org allowlist (the inviter already vouched for them).
    const invited = state.invite ? await peekInvite(c, state.invite) : null
    if (!invited && !(await isGitHubSignInAllowed(oauth, accessToken, identity, cfg))) {
      return c.json(
        { error: { code: 'forbidden', message: `@${identity.login} is not allowed to sign in` } },
        403,
      )
    }
    const user = await container.userService.findOrCreateByIdentity('github', String(identity.id), {
      name: identity.name,
      email: identity.email,
      avatarUrl: identity.avatarUrl,
      metadata: { login: identity.login },
    })
    await container.accountService.ensurePersonalAccount({
      id: user.id,
      login: identity.login,
      name: user.name,
    })
    if (state.invite) await acceptInvite(c, state.invite, user.id)
    const token = await mintSession(cfg, sessionUser(user, identity.login))
    return c.redirect(withToken(state.redirect, token))
  })

  // ---- Google OAuth -------------------------------------------------------

  app.get('/google/login', async (c) => {
    const cfg = authConfig(c)
    const google = googleClient(cfg)
    if (!google) return unavailable(c)
    const nonce = crypto.randomUUID()
    const state: OAuthState = {
      aud: TOKEN_AUDIENCE.oauthState,
      nonce,
      redirect: resolveRedirect(c, cfg),
      ...(c.req.query('invite') ? { invite: c.req.query('invite') } : {}),
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
    return c.redirect(google.authorizeUrl({ redirectUri: googleCallbackUrl(c, cfg), state: signedState }))
  })

  app.get('/google/callback', async (c) => {
    const cfg = authConfig(c)
    const google = googleClient(cfg)
    if (!google) return unavailable(c)
    const state = await consumeState(c, cfg)
    const code = c.req.query('code')
    if (!code || !state) {
      return c.json({ error: { code: 'validation', message: 'Invalid OAuth callback' } }, 400)
    }
    const accessToken = await google.exchangeCode(code, googleCallbackUrl(c, cfg))
    const identity = await google.fetchUser(accessToken)
    const container = c.get('container')

    const existing = await container.userService.findByIdentity('google', identity.subject)
    // Gate NEW-user creation: an invite OR an allowlisted email domain is required.
    const invited = state.invite ? await peekInvite(c, state.invite) : null
    if (!existing) {
      const allowed = !!invited || (identity.email ? emailDomainAllowed(identity.email, cfg) : false)
      if (!allowed) {
        return c.json(
          { error: { code: 'forbidden', message: 'Sign-up requires an invitation' } },
          403,
        )
      }
    }
    const user = await container.userService.findOrCreateByIdentity('google', identity.subject, {
      name: identity.name,
      email: identity.email,
      avatarUrl: identity.avatarUrl,
      metadata: { email: identity.email },
    })
    await container.accountService.ensurePersonalAccount({
      id: user.id,
      login: identity.email || user.id,
      name: user.name,
    })
    if (state.invite) await acceptInvite(c, state.invite, user.id)
    const token = await mintSession(cfg, sessionUser(user, identity.email || user.id))
    return c.redirect(withToken(state.redirect, token))
  })

  // ---- Email / password ---------------------------------------------------

  app.post('/signup', jsonBody(signupSchema), async (c) => {
    const cfg = authConfig(c)
    if (!cfg.passwordEnabled) return unavailable(c)
    const body = c.req.valid('json')
    const container = c.get('container')

    // New-user creation is gated: a valid invite OR an allowlisted email domain.
    const invited = body.invite ? await peekInvite(c, body.invite) : null
    const allowed = !!invited || emailDomainAllowed(body.email, cfg)
    if (!allowed) {
      return c.json(
        { error: { code: 'forbidden', message: 'Sign-up requires an invitation' } },
        403,
      )
    }
    try {
      const user = await container.userService.signupWithPassword({
        email: body.email,
        password: body.password,
        name: body.name,
      })
      await container.accountService.ensurePersonalAccount({
        id: user.id,
        login: user.email || user.id,
        name: user.name,
      })
      if (body.invite) await acceptInvite(c, body.invite, user.id)
      const token = await mintSession(cfg, sessionUser(user, user.email || user.id))
      return c.json({ token, user: sessionUser(user, user.email || user.id) }, 201)
    } catch (err) {
      if (err instanceof ConflictError || err instanceof ValidationError) {
        return c.json({ error: { code: 'validation', message: err.message } }, 400)
      }
      throw err
    }
  })

  app.post('/password-login', jsonBody(passwordLoginSchema), async (c) => {
    const cfg = authConfig(c)
    if (!cfg.passwordEnabled) return unavailable(c)
    const body = c.req.valid('json')
    const user = await c.get('container').userService.verifyPassword(body)
    if (!user) {
      return c.json({ error: { code: 'unauthorized', message: 'Invalid email or password' } }, 401)
    }
    const token = await mintSession(cfg, sessionUser(user, user.email || user.id))
    return c.json({ token, user: sessionUser(user, user.email || user.id) })
  })

  // ---- Invitations (peek + accept) ----------------------------------------

  // Public peek so the SPA can show the org name on the accept screen.
  app.get('/invitations/:token', async (c) => {
    const container = c.get('container')
    if (!container.invitations) return c.json({ valid: false })
    const record = await container.invitations.peek(c.req.param('token'))
    if (!record) return c.json({ valid: false })
    const account = await container.accountService.get(record.accountId)
    return c.json({ valid: true, email: record.email, accountName: account?.name ?? null })
  })

  // Accept an invitation as the signed-in user (the SPA calls this after login).
  app.post('/invitations/:token/accept', async (c) => {
    const user = await verifySession(c)
    if (!user) {
      return c.json({ error: { code: 'unauthorized', message: 'Sign in to accept' } }, 401)
    }
    const container = c.get('container')
    if (!container.invitations) {
      return c.json({ error: { code: 'unavailable', message: 'Invitations not configured' } }, 503)
    }
    const accountId = await container.invitations.accept(c.req.param('token'), user.id)
    return c.json({ accountId })
  })

  // Who am I? Used by the SPA to validate a stored token on boot.
  app.get('/me', async (c) => {
    if (!authConfig(c).enabled) return c.json({ user: null, enabled: false })
    const user = await verifySession(c)
    if (!user) {
      return c.json({ error: { code: 'unauthorized', message: 'Not authenticated' } }, 401)
    }
    return c.json({
      user: {
        id: user.id,
        login: user.login,
        name: user.name,
        avatarUrl: user.avatarUrl,
        email: user.email ?? null,
      },
      enabled: true,
    })
  })

  // Stateless sessions: logout is a client-side token drop. Provided for symmetry.
  app.post('/logout', (c) => c.body(null, 204))

  return app
}

/** Verify + single-use the OAuth state (signature, expiry, browser-binding cookie). */
async function consumeState(c: Context<AppEnv>, cfg: AuthConfig): Promise<OAuthState | null> {
  const state = await new HmacSigner(cfg.sessionSecret).verify<OAuthState>(c.req.query('state'), {
    aud: TOKEN_AUDIENCE.oauthState,
  })
  const boundNonce = getCookie(c, OAUTH_STATE_COOKIE)
  deleteCookie(c, OAUTH_STATE_COOKIE, { path: '/auth' })
  if (!state || !boundNonce || boundNonce !== state.nonce) return null
  return state
}

async function peekInvite(c: Context<AppEnv>, token: string) {
  const inv = c.get('container').invitations
  return inv ? inv.peek(token) : null
}

async function acceptInvite(c: Context<AppEnv>, token: string, userId: string): Promise<void> {
  const inv = c.get('container').invitations
  if (!inv) return
  try {
    await inv.accept(token, userId)
  } catch {
    // A stale/expired invite must not block an otherwise-valid login.
  }
}
