import { UnauthorizedError, UnavailableError } from '@cat-factory/kernel'
import type { Context } from 'hono'
import type { SessionUser } from '../auth/signing.js'
import type { AppEnv } from './env.js'

/**
 * The two guards every controller repeats. Both THROW a `DomainError` rather than building an
 * envelope, so the single `handleError` funnel owns the wire shape and the refusal can carry
 * `details.reason` — a hand-built `c.json({ error: { code } }, 503)` structurally cannot
 * (observability-logging-gaps.md, B2).
 *
 * Sibling of `params.ts`'s `param()`: a one-line TOTAL accessor in place of a nullable read
 * plus a guard at every call site. That shape is what retires the per-controller
 * `requireX(c): Module | null` + `unavailable()` pair — the `| null` return is what forced
 * every route to restate the guard, and 51 controllers had each declared their own copy of the
 * thrower to satisfy it.
 *
 * Each has an `assert*` twin for the route that needs the capability WIRED but reads nothing
 * off it, because it calls through a different path (the engine, say, rather than the module's
 * own service). Discarding a `require*` result reads as a no-op statement — nothing at the call
 * site says the line IS the 503 — so the next reader, or a mechanical "drop the unused call"
 * cleanup, deletes the guard and no test fails. The `void` return type is what makes the intent
 * local to the line.
 */

/**
 * The signed-in user, or a 401. `message` is the action being refused, so the SPA can word the
 * sign-in prompt ("Sign in to manage your API keys") rather than showing a generic 401.
 */
export function requireUser<E extends AppEnv>(c: Context<E>, message: string): SessionUser {
  const user = c.get('user')
  if (!user) throw new UnauthorizedError(message)
  return user
}

/**
 * An optional container capability (an opt-in integration module, a facade-wired repository),
 * or a 503 naming what isn't wired. The request is well-formed and the caller is entitled to
 * it — this deployment just has nothing behind the route.
 *
 * `reason` is the machine-readable half, and a route owes one wherever the SAME unwired fact is
 * already reported with a reason somewhere else: a client that branches on
 * `details.reason: 'model_presets_unwired'` from a refused pin, and then string-matches prose on
 * the list endpoint it hits first, is being asked to handle one condition two ways.
 */
export function requireCapability<T>(
  value: T | undefined | null,
  message: string,
  reason?: string,
): T {
  if (value === undefined || value === null) throw new UnavailableError(message, reason)
  return value
}

/**
 * {@link requireUser} for a route that needs a signed-in caller but reads nothing off them —
 * the identity is the authorization, and the work is scoped by the path instead.
 */
export function assertUser<E extends AppEnv>(c: Context<E>, message: string): void {
  requireUser(c, message)
}

/**
 * {@link requireCapability} for a route that needs the capability wired but calls through a
 * different path — a review module whose mutations are driven by the execution service, say.
 * The refusal is the whole point of the line: without it the route answers as though the
 * integration were present, on a deployment that never wired it.
 */
export function assertCapability(value: unknown, message: string, reason?: string): void {
  requireCapability(value, message, reason)
}
