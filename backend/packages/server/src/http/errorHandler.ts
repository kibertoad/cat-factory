import { DomainError, describeError, redactSecrets } from '@cat-factory/kernel'
import { SchemaValidationError } from '@toad-contracts/core'
import type { Context } from 'hono'
import type { ContentfulStatusCode } from 'hono/utils/http-status'
import type { AppEnv } from './env.js'
import { requestIdOf, requestLogger } from './requestLogging.js'

const STATUS_BY_CODE: Record<DomainError['code'], ContentfulStatusCode> = {
  not_found: 404,
  validation: 422,
  conflict: 409,
  // Precondition Required: a user-scoped personal credential (password/subscription)
  // must be supplied before the action can proceed (individual-usage restricted mode).
  credential_required: 428,
  // Forbidden: the caller sees the resource but lacks the capability (workspace RBAC).
  // A caller who may not even see the resource gets a 404, never this — see ForbiddenError.
  forbidden: 403,
  // Service Unavailable: a capability this deployment never wired (an opt-in integration).
  unavailable: 503,
  // Unauthorized: no (or an unverifiable) credential — "sign in", vs forbidden's "you can't".
  unauthorized: 401,
  // Too Many Requests: a caller or upstream rate limit; `details.retryAfterSeconds` when known.
  rate_limited: 429,
}

/**
 * The `WWW-Authenticate` header a refusal carries, on the routes that set a challenge.
 *
 * The envelope is unchanged; this is the HEADER half of the same refusal, and it exists because
 * some protocols make the 401 itself the entry point to discovery. An MCP host that gets a bare 401
 * has been told only that its credential is wrong: the deployment's protected-resource metadata is
 * served, correct and unreachable, because nothing pointed at it. RFC 6750 §3 is where a client
 * looks, so that is where the pointer goes.
 *
 * The 401 alone, deliberately. RFC 6750 also defines an `insufficient_scope` challenge on a 403,
 * and the surface that sets one today cannot produce that refusal: the hosted MCP endpoint gates on
 * `read`, the floor of an inclusive ladder, so every key that authenticates satisfies it and a
 * scope refusal comes from the individual `/api/v1` route the tools reach afterwards. A branch for
 * it here would be unreachable code that reads like protection.
 */
function authenticateHeader<E extends AppEnv>(
  c: Context<E>,
  error: DomainError,
): Record<string, string> | undefined {
  const challenge = c.get('bearerChallenge')
  if (!challenge || error.code !== 'unauthorized') return undefined
  return { 'www-authenticate': challenge }
}

/**
 * Maps domain errors to HTTP responses; anything else is a 500.
 *
 * Every envelope carries the request's `requestId` when `mountRequestLogging` is mounted, so a
 * user can quote the id off a failed request and an operator can grep the exact line — the join
 * that did not exist while 4xx responses left no server-side trace at all. The id is the ONLY
 * thing added to the wire shape; codes, messages and details are unchanged.
 */
export function handleError<E extends AppEnv>(error: unknown, c: Context<E>): Response {
  const requestId = requestIdOf(c)
  const correlation = requestId ? { requestId } : {}
  // A contract request schema (path/query/header/body) rejected the input. Surface the
  // same `{ error: { code: 'validation', ... } }` envelope the old @hono/valibot-validator
  // `jsonBody` middleware produced, so the wire shape is unchanged after the contract migration.
  if (error instanceof SchemaValidationError) {
    c.set('errorCode', 'validation')
    return c.json(
      {
        error: {
          code: 'validation',
          message: 'Request failed validation',
          ...correlation,
          issues: error.issues.map((issue) => ({
            path: issue.path
              ?.map((segment) =>
                typeof segment === 'object' && segment !== null && 'key' in segment
                  ? String((segment as { key: PropertyKey }).key)
                  : String(segment),
              )
              .join('.'),
            message: issue.message,
          })),
        },
      },
      400,
    )
  }
  if (error instanceof DomainError) {
    c.set('errorCode', error.code)
    return c.json(
      {
        error: {
          code: error.code,
          message: error.message,
          ...correlation,
          ...(error.details ? { details: error.details } : {}),
        },
      },
      STATUS_BY_CODE[error.code],
      authenticateHeader(c, error),
    )
  }
  // Unexpected fault: log it through the REQUEST-scoped logger (so the line carries the same
  // `requestId` the client just received, plus method/path from the bound fields) but never leak
  // internals to the client. The stack is attached explicitly because this is the one class of
  // failure where it is what identifies the fault — and it goes through `redactSecrets` in its
  // own right: a stack's FIRST LINE is `Error: <message>` verbatim, so attaching it raw beside
  // the scrubbed `err` would republish exactly what `describeError` just removed.
  c.set('errorCode', 'internal')
  const stack = error instanceof Error ? redactSecrets(error.stack ?? null) : null
  requestLogger(c).error('unhandled request error', {
    ...describeError(error),
    ...(stack ? { stack } : {}),
  })
  return c.json(
    { error: { code: 'internal', message: 'Internal server error', ...correlation } },
    500,
  )
}
