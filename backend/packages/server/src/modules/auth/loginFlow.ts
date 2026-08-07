import type { Context } from 'hono'
import { deleteCookie, getCookie, setCookie } from 'hono/cookie'
import { ConflictError, NotFoundError, UnauthorizedError } from '@cat-factory/kernel'
import type { UserRecord } from '@cat-factory/kernel'
import { verifySession } from '../../auth/middleware.js'
import {
  HmacSigner,
  type SessionPayload,
  type SessionUser,
  TOKEN_AUDIENCE,
} from '../../auth/signing.js'
import type { AuthConfig } from '../../config/types.js'
import type { AppEnv } from '../../http/env.js'

// ---------------------------------------------------------------------------
// The shared mechanics of a BROWSER login round-trip, used by every provider that redirects:
// GitHub OAuth, Google OAuth, and enterprise SSO.
//
// Extracted from `AuthController` when SSO landed, because the alternative was a second copy of
// the CSRF state, the redirect allow-listing and the session mint — the three pieces where a
// divergence is a vulnerability rather than an inconsistency:
//
//  - the signed, cookie-bound `state` nonce is the CSRF defence, and "one implementation" is what
//    the SSO design committed to;
//  - `pickPostLoginRedirect` guards a token-EXFILTRATION primitive (the session token rides the
//    landing URL's fragment), so a provider with its own laxer copy would hand an attacker the
//    session of anyone who clicked their link;
//  - `mintSession` is the one place the session claim shape lives.
// ---------------------------------------------------------------------------

/** How long a login round-trip's signed state stays valid. */
export const OAUTH_STATE_TTL_MS = 10 * 60 * 1000

/** Browser-binding cookie for an OAuth round-trip (the CSRF pair for the signed `state`). */
export const OAUTH_STATE_COOKIE = 'cf_oauth_state'

export interface OAuthState {
  aud: typeof TOKEN_AUDIENCE.oauthState
  nonce: string
  /** Where to send the browser (with the token) after a successful login. */
  redirect: string
  /** Optional invite token to redeem after a brand-new Google/GitHub signup. */
  invite?: string
  exp: number
}

export function authConfig<E extends AppEnv>(c: Context<E>): AuthConfig {
  return c.get('container').config.auth
}

/**
 * A loopback host (the user's OWN machine): `localhost`, the `127.0.0.0/8` block, or IPv6 `::1`.
 * A redirect to one of these is not an exfiltration vector — capturing the fragment there means
 * already running a server on the victim's own machine. This is what lets a mothership honour the
 * post-login redirect back to a mothership-mode LOCAL node (`http://localhost:PORT`), which is
 * neither same-origin nor pre-allowlisted, without an operator hand-listing every dev port.
 */
function isLoopbackRedirect(url: URL): boolean {
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '')
  return host === 'localhost' || host === '::1' || /^127\.\d+\.\d+\.\d+$/.test(host)
}

/**
 * Choose the post-login landing URL from the (untrusted) `redirect` query. The
 * session token is appended as a fragment, so an unrestricted redirect is a
 * token-exfiltration primitive — only same-origin, an explicitly allowlisted origin, or a
 * loopback host (the caller's own machine) is honoured, else the request origin.
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
    if (
      url.origin === requestOrigin ||
      cfg.allowedRedirectOrigins.includes(url.origin) ||
      isLoopbackRedirect(url)
    ) {
      return requested
    }
  } catch {
    // fall through to the safe origin-relative default
  }
  return fallback
}

export function resolveRedirect<E extends AppEnv>(c: Context<E>, cfg: AuthConfig): string {
  return pickPostLoginRedirect(c.req.query('redirect'), new URL(c.req.url).origin, cfg)
}

/** Append the session token as a URL fragment on the landing URL. */
export function withToken(redirect: string, token: string): string {
  const url = new URL(redirect)
  url.hash = `token=${token}`
  return url.toString()
}

/** Build the SessionUser surface from a canonical user + chosen display login. */
export function sessionUser(user: UserRecord, login: string): SessionUser {
  return {
    id: user.id,
    login,
    name: user.name,
    avatarUrl: user.avatarUrl,
    email: user.email,
  }
}

/**
 * Mint a user SESSION token, returning the signed token and the exact `exp` it committed to so a
 * caller can report the real expiry without a second clock read. Shared by every login path AND
 * the local-mode mothership-connect controller, so the session claim shape lives in one place.
 *
 * `generation` is the user's session generation, stamped into the token so revocation can
 * invalidate it later. It is a REQUIRED parameter rather than something resolved in here, because
 * this function takes a `SessionUser` (a display surface) and has no store to read: making each
 * login path supply it is what forces every one of them to have looked. A mint that stamped a
 * default would issue a token the revocation check could never refuse.
 */
export async function mintSession(
  cfg: AuthConfig,
  user: SessionUser,
  generation: number,
): Promise<{ token: string; exp: number }> {
  const exp = Date.now() + cfg.sessionTtlMs
  const session: SessionPayload = { ...user, aud: TOKEN_AUDIENCE.session, exp, gen: generation }
  return { token: await new HmacSigner(cfg.sessionSecret).sign(session), exp }
}

/**
 * The generation to stamp into a session being minted for a user who was just resolved (or
 * created) by a login flow.
 *
 * Reads PAST the cache (`refreshSessionGeneration`), which is the one difference from the
 * accessor `verifySession` uses on the request path. Verification tolerates a bounded stale
 * window on purpose; a mint cannot, because what it reads is stamped into a bearer that outlives
 * the cache entry. A generation read one bump behind on a replica that missed the invalidation
 * issues a token every replica refuses for its whole TTL, and the refusal spreads rather than
 * heals as the caches that still agreed with it expire — a sign-in loop no waiting fixes. The
 * refresh also repopulates this replica, so the token it just minted verifies here.
 *
 * A user the store cannot find falls back to `0`: the login path has this instant established
 * that the user exists, so a null here is a read racing a create rather than an absent person,
 * and `0` is the generation a fresh row carries. Getting it wrong costs one re-login, never an
 * unrevocable token — a stamped generation BELOW the row's is refused, never admitted.
 */
export async function sessionGenerationFor<E extends AppEnv>(
  c: Context<E>,
  userId: string,
): Promise<number> {
  return (await c.get('container').userService.refreshSessionGeneration(userId)) ?? 0
}

/**
 * The caller's own session on a route mounted under a PUBLIC prefix, or a 401.
 *
 * `requireUser` (the `http/guards.ts` accessor every other controller reaches for) is WRONG here
 * and reads as right, which is why this exists rather than being inlined. It narrows
 * `c.get('user')`, and the only thing that ever sets that is `requireAuth` — which
 * `mountAuthGate` deliberately does not run under `/auth`, because the login round-trips
 * themselves must be reachable unauthenticated. A `requireUser` on an `/auth` route is therefore
 * not a guard at all: it is an unconditional 401 that no test of the happy path can distinguish
 * from a missing token.
 *
 * So the session is verified HERE, on the route, the same way `/auth/me` does it, and any future
 * authenticated `/auth` route reaches for this instead of re-deriving the trap.
 */
export async function requireSessionUser<E extends AppEnv>(
  c: Context<E>,
  message: string,
): Promise<SessionPayload> {
  const user = await verifySession(c)
  if (!user) throw new UnauthorizedError(message)
  return user
}

/**
 * A verified session payload back down to the display surface a mint takes.
 *
 * Projected FIELD BY FIELD rather than spread or hand-picked at the call site. A spread would
 * carry the OLD token's `aud`/`exp`/`gen` into the new session's claim object (harmless only
 * because the mint happens to overwrite all three, which is not a property to depend on), and
 * hand-picking is how `email` — optional on {@link SessionUser}, so its omission typechecks —
 * was silently dropped from a re-minted token, leaving `/auth/me` reporting a null address and
 * invitation matching unable to find the person.
 */
export function sessionUserFrom(payload: SessionPayload): SessionUser {
  return {
    id: payload.id,
    login: payload.login,
    name: payload.name,
    avatarUrl: payload.avatarUrl,
    email: payload.email,
  }
}

/** Whether an email's domain is on the self-signup allowlist. */
export function emailDomainAllowed(email: string, cfg: AuthConfig): boolean {
  const at = email.lastIndexOf('@')
  if (at < 0) return false
  const domain = email.slice(at + 1).toLowerCase()
  return cfg.allowedEmailDomains.includes(domain)
}

/**
 * Set a round-trip's browser-binding cookie. `Lax` is deliberate and sufficient: every callback
 * this covers arrives as a top-level GET navigation, which Lax permits.
 */
export function setRoundTripCookie<E extends AppEnv>(
  c: Context<E>,
  name: string,
  value: string,
): void {
  setCookie(c, name, value, {
    httpOnly: true,
    secure: new URL(c.req.url).protocol === 'https:',
    sameSite: 'Lax',
    path: '/auth',
    maxAge: OAUTH_STATE_TTL_MS / 1000,
  })
}

/** Verify + single-use the OAuth state (signature, expiry, browser-binding cookie). */
export async function consumeState<E extends AppEnv>(
  c: Context<E>,
  cfg: AuthConfig,
): Promise<OAuthState | null> {
  const state = await new HmacSigner(cfg.sessionSecret).verify<OAuthState>(c.req.query('state'), {
    aud: TOKEN_AUDIENCE.oauthState,
  })
  const boundNonce = getCookie(c, OAUTH_STATE_COOKIE)
  deleteCookie(c, OAUTH_STATE_COOKIE, { path: '/auth' })
  if (!state || !boundNonce || boundNonce !== state.nonce) return null
  return state
}

/** Begin a redirect round-trip: sign the state and bind it to the browser with a cookie. */
export async function beginRoundTrip<E extends AppEnv>(
  c: Context<E>,
  cfg: AuthConfig,
): Promise<string> {
  const nonce = crypto.randomUUID()
  const state: OAuthState = {
    aud: TOKEN_AUDIENCE.oauthState,
    nonce,
    redirect: resolveRedirect(c, cfg),
    ...(c.req.query('invite') ? { invite: c.req.query('invite') } : {}),
    exp: Date.now() + OAUTH_STATE_TTL_MS,
  }
  const signedState = await new HmacSigner(cfg.sessionSecret).sign(state)
  setRoundTripCookie(c, OAUTH_STATE_COOKIE, nonce)
  return signedState
}

export async function peekInvite<E extends AppEnv>(c: Context<E>, token: string) {
  const inv = c.get('container').invitations
  return inv ? inv.peek(token) : null
}

/** Whether a sign-in email matches the address an invitation was sent to. */
export function emailMatchesInvite(
  signInEmail: string | null | undefined,
  inviteEmail: string,
): boolean {
  return !!signInEmail && signInEmail.toLowerCase().trim() === inviteEmail
}

export async function acceptInvite<E extends AppEnv>(
  c: Context<E>,
  token: string,
  userId: string,
  userEmail: string | null,
): Promise<void> {
  const inv = c.get('container').invitations
  if (!inv) return
  try {
    await inv.accept(token, userId, userEmail)
  } catch (err) {
    // Expected invite states (expired / already-used / wrong email) must not block an
    // otherwise-valid login; an unexpected infra error should still surface.
    if (err instanceof ConflictError || err instanceof NotFoundError) return
    throw err
  }
}
