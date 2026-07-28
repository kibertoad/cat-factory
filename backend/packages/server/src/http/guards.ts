import { UnauthorizedError, UnavailableError } from '@cat-factory/kernel'
import type { Context } from 'hono'
import type { SessionUser } from '../auth/signing.js'
import type { AppEnv } from './env.js'

/**
 * The two guards every controller repeats. Both THROW a {@link DomainError} rather than
 * building an envelope, so the single `handleError` funnel owns the wire shape and the
 * error can carry `details.reason` — a hand-built `c.json({ error: { code } }, 503)`
 * structurally cannot (observability-logging-gaps.md, B2).
 *
 * Sibling of `params.ts`'s `param()`: a one-line total accessor in place of a nullable
 * read plus a guard at every call site.
 */

/**
 * The signed-in user, or a 401. `message` is the action being refused, so the SPA can
 * word the sign-in prompt ("Sign in to manage your API keys") rather than showing a
 * generic 401.
 */
export function requireUser<E extends AppEnv>(c: Context<E>, message: string): SessionUser {
  const user = c.get('user')
  if (!user) throw new UnauthorizedError(message)
  return user
}

/**
 * An optional container capability (an opt-in integration module, a facade-wired
 * repository), or a 503 naming what isn't wired. The request is well-formed and the
 * caller is entitled to it — this deployment just has nothing behind the route.
 */
export function requireCapability<T>(value: T | undefined | null, message: string): T {
  if (value === undefined || value === null) throw new UnavailableError(message)
  return value
}
