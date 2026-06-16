import type { Context, MiddlewareHandler } from 'hono'
import type { AppEnv } from '../http/types'
import { HmacSigner, TOKEN_AUDIENCE, type SessionPayload } from './signing'

// Bearer-token auth for the API. The session token is minted by the OAuth
// callback (see AuthController) and carried by the SPA as `Authorization:
// Bearer <token>`.
//
// The gate FAILS CLOSED: if auth is unconfigured, protected routes are refused
// (503) rather than served openly — production must always have auth present.
// The only way to run open is the explicit local-dev/test escape hatch
// `AUTH_DEV_OPEN=true` (config.auth.devOpen), set in `.dev.vars` and the test
// bindings but never in the deployed wrangler.toml.

/** Extract the bearer token from the Authorization header, if present. */
export function bearerToken(c: Context<AppEnv>): string | null {
  const header = c.req.header('Authorization')
  if (!header) return null
  const match = /^Bearer\s+(.+)$/i.exec(header.trim())
  return match ? match[1]! : null
}

/** Verify the request's bearer token against the configured session secret. */
export function verifySession(c: Context<AppEnv>): Promise<SessionPayload | null> {
  const cfg = c.get('container').config.auth
  if (!cfg.enabled) return Promise.resolve(null)
  // Pin the `session` audience: a container LLM-proxy token or a WS ticket — both
  // signed with the same secret — must NOT be accepted as a user session.
  return new HmacSigner(cfg.sessionSecret).verify<SessionPayload>(bearerToken(c), {
    aud: TOKEN_AUDIENCE.session,
  })
}

/**
 * Gate a route group. Preflight (OPTIONS) is always allowed so CORS isn't broken.
 * When auth is enabled, require a valid session and stash the user on the
 * context. When it is NOT configured, fail closed (503) — unless the local-dev
 * escape hatch `AUTH_DEV_OPEN` is set, which passes through (dev + tests).
 */
export function requireAuth(): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    if (c.req.method === 'OPTIONS') return next()
    const cfg = c.get('container').config.auth
    if (!cfg.enabled) {
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

    const user = await verifySession(c)
    if (!user) {
      return c.json({ error: { code: 'unauthorized', message: 'Authentication required' } }, 401)
    }
    c.set('user', user)
    await next()
  }
}
