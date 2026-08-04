import type { PublicApiScope } from '@cat-factory/contracts'
import { scopeSatisfies, type PublicApiKeyAuth } from '@cat-factory/integrations'
import { ForbiddenError, UnauthorizedError, UnavailableError } from '@cat-factory/kernel'
import type { Context } from 'hono'
import type { AppEnv } from '../../http/env.js'

// The in-controller bearer-key gate shared by every `/api/v1` controller. The public surface is
// NOT behind the SPA's session gate (its `/api` prefix is in the authGate bypass list), so each
// route authenticates here — mirroring how `/internal` self-authenticates with a machine token.
// Lives in its own module because the surface is now more than one controller (the board/job
// routes in `PublicApiController`, the parked-decision routes in `PublicDecisionController`) and
// both MUST resolve keys and ladder scopes through exactly one implementation.

/**
 * The outcome of authenticating a public-API call: the resolved key scope, or a `fail` describing
 * the error the handler should emit. Kept as DATA rather than a `Response` so the contract
 * handlers stay typed against their declared response schemas.
 */
export type KeyResult =
  | { auth: PublicApiKeyAuth }
  | { fail: { status: 401 | 403 | 503; code: string; message: string } }

/**
 * The raw key the caller presented, stripped of its `Bearer` prefix.
 *
 * Shared rather than re-derived, because the hosted MCP endpoint FORWARDS the key onto the calls its
 * tools make: a second copy of this parse could admit a key here and hand a differently-trimmed one
 * to the SDK, which authenticates as nobody.
 */
export function bearerToken<E extends AppEnv>(c: Context<E>): string | undefined {
  return c.req.header('authorization')?.replace(/^Bearer\s+/i, '')
}

/**
 * Render an auth `fail` as its response. Lives here rather than in each controller because the
 * refusal shape is part of the surface's contract, not a per-route choice: every `/api/v1` handler
 * emits the SAME `{ error: { code, message } }` at the SAME status, and a controller that spelt it
 * out itself is one that can drift from the rest by a copy-paste.
 *
 * Hand-built rather than a thrown `DomainError` for the reason {@link KeyResult} exists: on this
 * surface a refusal is DATA the contract handler returns, so the handler stays typed against its
 * declared response schemas.
 */
export function refuse<E extends AppEnv>(
  c: Context<E>,
  fail: Extract<KeyResult, { fail: unknown }>['fail'],
) {
  return c.json({ error: { code: fail.code, message: fail.message } }, fail.status)
}

/** Resolve the caller's public-API key to a workspace scope, or the error to emit. */
export async function resolveKey<E extends AppEnv>(c: Context<E>): Promise<KeyResult> {
  const svc = c.get('container').publicApiKeys
  if (!svc) {
    return { fail: { status: 503, code: 'unavailable', message: 'Public API is not configured' } }
  }
  const auth = await svc.authenticate(bearerToken(c))
  if (!auth) {
    return { fail: { status: 401, code: 'unauthorized', message: 'Invalid or missing API key' } }
  }
  return { auth }
}

/**
 * Authenticate the caller AND require a minimum permission scope. The scope ladder is inclusive
 * (read ⊂ write ⊂ decide ⊂ admin), so a `write` key satisfies a `read` requirement and an `admin`
 * key satisfies any. A valid key whose scope is too low is a 403 `insufficient_scope` (distinct
 * from the 401 an unknown/absent key gets) — the caller can tell "wrong key" from "key can't do
 * this". Every `/api/v1` handler gates through this, naming the least scope it needs.
 */
export async function authorize<E extends AppEnv>(
  c: Context<E>,
  need: PublicApiScope,
): Promise<KeyResult> {
  const result = await resolveKey(c)
  if ('fail' in result) return result
  if (!scopeSatisfies(result.auth.scope, need)) {
    return {
      fail: {
        status: 403,
        code: 'insufficient_scope',
        message: `This action requires a '${need}'-scope key; this key is scoped '${result.auth.scope}'`,
      },
    }
  }
  return result
}

/**
 * {@link authorize} for a route with no contract-declared response schema: the refusal is THROWN as
 * a `DomainError` so `handleError` renders it, correlation id and all.
 *
 * The `fail`-as-data shape above exists because the contract handlers must stay typed against their
 * declared responses; a hand-mounted route (the MCP endpoint) has no such obligation and gets the
 * repo's default instead of a fourth hand-built envelope. Same ladder either way: the scope rule
 * lives in exactly one place, and this is a translation of its verdict rather than a second copy.
 *
 * `details.reason` carries the machine-readable cause, since `code` is only the status class: an
 * `insufficient_scope` needs a wider key, a `invalid_api_key` a valid one, and an unconfigured
 * public API needs the deployment's operator.
 */
export async function authorizeOrThrow<E extends AppEnv>(
  c: Context<E>,
  need: PublicApiScope,
): Promise<PublicApiKeyAuth> {
  const result = await authorize(c, need)
  if (!('fail' in result)) return result.auth
  const { status, code, message } = result.fail
  switch (status) {
    case 401:
      throw new UnauthorizedError(message, 'invalid_api_key')
    case 403:
      throw new ForbiddenError(message, { reason: code, requiredScope: need })
    case 503:
      throw new UnavailableError(message, 'public_api_unconfigured')
  }
}
