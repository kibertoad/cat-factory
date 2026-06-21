import { DomainError } from '@cat-factory/kernel'
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
