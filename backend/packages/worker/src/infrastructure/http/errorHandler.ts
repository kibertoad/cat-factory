import { DomainError } from '@cat-factory/core'
import type { Context } from 'hono'
import type { ContentfulStatusCode } from 'hono/utils/http-status'

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
  console.error('Unhandled error', error)
  return c.json(
    { error: { code: 'internal', message: 'Internal server error' } },
    500,
  )
}
