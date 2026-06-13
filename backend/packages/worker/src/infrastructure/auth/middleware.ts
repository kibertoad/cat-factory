import type { Context, MiddlewareHandler } from 'hono'
import type { AppEnv } from '../http/types'
import { HmacSigner, type SessionPayload } from './signing'

// Bearer-token auth for the API. The session token is minted by the OAuth
// callback (see AuthController) and carried by the SPA as `Authorization:
// Bearer <token>`. When auth is unconfigured the gate is a no-op, so local dev
// and the test suite — which send no credentials — behave exactly as before.

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
  return new HmacSigner(cfg.sessionSecret).verify<SessionPayload>(bearerToken(c))
}

/**
 * Gate a route group: when auth is enabled, require a valid session and stash
 * the user on the context; otherwise pass through. Preflight (OPTIONS) is always
 * allowed so CORS isn't broken by the gate.
 */
export function requireAuth(): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    if (c.req.method === 'OPTIONS') return next()
    const cfg = c.get('container').config.auth
    if (!cfg.enabled) return next()

    const user = await verifySession(c)
    if (!user) {
      return c.json({ error: { code: 'unauthorized', message: 'Authentication required' } }, 401)
    }
    c.set('user', user)
    await next()
  }
}
