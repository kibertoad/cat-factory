import type { Context, MiddlewareHandler } from 'hono'
import type { AppEnv } from '../http/env.js'
import { signerFor, TOKEN_AUDIENCE, type SessionPayload } from './signing.js'
import { UnauthorizedError } from '@cat-factory/kernel'

// Bearer-token auth for the API. The session token is minted by the OAuth
// callback (see the facade's AuthController) and carried by the SPA as
// `Authorization: Bearer <token>`.
//
// The gate FAILS CLOSED: if auth is unconfigured, protected routes are refused
// (503) rather than served openly — production must always have auth present.
// The only way to run open is the explicit local-dev/test escape hatch
// `AUTH_DEV_OPEN=true` (config.auth.devOpen).

// The functions are generic over the Hono env so a facade whose app adds runtime
// `Bindings` (e.g. the Worker's `Env`) on top of the shared Variables can still use
// them — Hono's Context is invariant, so a non-generic `Context<AppEnv>` would reject
// a `Context<AppEnv & { Bindings }>`.

/** Extract the bearer token from the Authorization header, if present. */
export function bearerToken<E extends AppEnv>(c: Context<E>): string | null {
  const header = c.req.header('Authorization')
  if (!header) return null
  const match = /^Bearer\s+(.+)$/i.exec(header.trim())
  return match ? match[1]! : null
}

/**
 * Verify the request's bearer token against the configured session secret. Gated on the
 * SECRET being present, NOT on `cfg.enabled`: local mode can mint a real session (PAT /
 * password login) while running `devOpen` with auth otherwise "disabled", and that session
 * must still resolve to its user. With no secret there's nothing to verify against → null.
 *
 * Two gates, in this order. The HMAC + audience check proves the deployment issued this token for
 * a user session; the GENERATION check proves the session has not since been revoked. The second
 * is a store read (cached), which is the whole cost of making a stateless token revocable — see
 * {@link sessionIsCurrent}.
 */
export async function verifySession<E extends AppEnv>(
  c: Context<E>,
): Promise<SessionPayload | null> {
  const cfg = c.get('container').config.auth
  if (!cfg.sessionSecret) return null
  // Pin the `session` audience: a container LLM-proxy token or a WS ticket — both
  // signed with the same secret — must NOT be accepted as a user session.
  const payload = await signerFor(cfg.sessionSecret).verify<SessionPayload>(bearerToken(c), {
    aud: TOKEN_AUDIENCE.session,
  })
  if (!payload) return null
  return (await sessionIsCurrent(c, payload)) ? payload : null
}

/**
 * Whether a cryptographically valid session is still one the user has not revoked.
 *
 * The comparison is against the user's stored generation, read through the app cache
 * (`UserService.sessionGeneration`), so "sign out all devices" and an SSO offboarding are one row
 * write rather than a token blocklist.
 *
 * Three refusals, all deliberate:
 *  - a token carrying NO `gen` claim (minted before the column existed) is refused, never treated
 *    as current: an absent-claim-means-valid reading would be a permanent bypass, and the cost of
 *    refusing is one re-login;
 *  - a token whose `gen` differs from the row in EITHER direction is refused, rather than only a
 *    lower one. A claim above the row cannot be produced by any mint this deployment performs, so
 *    it means the row moved backwards (a restore) or the token was tampered with under a secret we
 *    should not be trusting; admitting it would make a rolled-back database re-admit revoked
 *    sessions;
 *  - a user the store has no row for is refused, which is what closes the deleted-user bearer.
 *
 * A store FAILURE is none of those: it propagates rather than resolving false, so an outage
 * surfaces as a 500 the operator can act on instead of a fleet-wide 401 that reads to every user
 * as "your credentials are wrong" and sends them to a login that cannot work either.
 */
async function sessionIsCurrent<E extends AppEnv>(
  c: Context<E>,
  payload: SessionPayload,
): Promise<boolean> {
  if (typeof payload.gen !== 'number') return false
  const current = await c.get('container').userService.sessionGeneration(payload.id)
  return current !== null && current === payload.gen
}

/**
 * Gate a route group. Preflight (OPTIONS) is always allowed so CORS isn't broken.
 * When auth is enabled, require a valid session and stash the user on the
 * context. When it is NOT configured, fail closed (503) — unless the local-dev
 * escape hatch `AUTH_DEV_OPEN` is set, which passes through (dev + tests).
 */
export function requireAuth<E extends AppEnv>(): MiddlewareHandler<E> {
  return async (c, next) => {
    if (c.req.method === 'OPTIONS') return next()
    const cfg = c.get('container').config.auth
    // Always try the session first: a valid token resolves to its user even when auth is
    // otherwise "disabled" (local mode minted it via PAT / password login under devOpen),
    // so per-user routes work for a signed-in local developer.
    const user = await verifySession(c)
    if (user) {
      c.set('user', user)
      return next()
    }
    // No (valid) session. When auth is on, that's a 401. When off, the local-dev escape
    // hatch passes through anonymously (open API for dev/tests); otherwise fail closed.
    if (cfg.enabled) {
      throw new UnauthorizedError('Authentication required')
    }
    if (cfg.devOpen) return next()
    return c.json(
      {
        error: {
          code: 'auth_not_configured',
          message:
            'Authentication is required but not configured. Set the GitHub OAuth ' +
            'credentials and AUTH_SESSION_SECRET, or AUTH_DEV_OPEN=true for local dev.',
        },
      },
      503,
    )
  }
}
