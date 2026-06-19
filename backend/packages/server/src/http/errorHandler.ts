import { DomainError } from '@cat-factory/kernel'
import type { Context } from 'hono'
import type { ContentfulStatusCode } from 'hono/utils/http-status'
import { logger } from '../observability/logger.js'

const STATUS_BY_CODE: Record<DomainError['code'], ContentfulStatusCode> = {
  not_found: 404,
  validation: 422,
  conflict: 409,
}

/** Maps domain errors to HTTP responses; anything else is a 500. */
export function handleError(error: unknown, c: Context): Response {
  if (error instanceof DomainError) {
    return c.json(
      { error: { code: error.code, message: error.message } },
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
