import { DomainError } from '@cat-factory/kernel'
import { SchemaValidationError } from '@toad-contracts/core'
import type { Context } from 'hono'
import type { ContentfulStatusCode } from 'hono/utils/http-status'
import { logger } from '../observability/logger.js'

const STATUS_BY_CODE: Record<DomainError['code'], ContentfulStatusCode> = {
  not_found: 404,
  validation: 422,
  conflict: 409,
  // Precondition Required: a user-scoped personal credential (password/subscription)
  // must be supplied before the action can proceed (individual-usage restricted mode).
  credential_required: 428,
}

/** Maps domain errors to HTTP responses; anything else is a 500. */
export function handleError(error: unknown, c: Context): Response {
  // A contract request schema (path/query/header/body) rejected the input. Surface the
  // same `{ error: { code: 'validation', ... } }` envelope the old @hono/valibot-validator
  // `jsonBody` middleware produced, so the wire shape is unchanged after the contract migration.
  if (error instanceof SchemaValidationError) {
    return c.json(
      {
        error: {
          code: 'validation',
          message: 'Request failed validation',
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
    return c.json(
      {
        error: {
          code: error.code,
          message: error.message,
          ...(error.details ? { details: error.details } : {}),
        },
      },
      STATUS_BY_CODE[error.code],
    )
  }
  // Unexpected fault: log it with request context so it's traceable, but never
  // leak internals to the client.
  logger.error(
    {
      err:
        error instanceof Error
          ? { message: error.message, stack: error.stack }
          : { message: String(error) },
      method: c.req.method,
      path: new URL(c.req.url).pathname,
    },
    'unhandled request error',
  )
  return c.json({ error: { code: 'internal', message: 'Internal server error' } }, 500)
}
