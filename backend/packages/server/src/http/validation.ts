import { vValidator } from '@hono/valibot-validator'
import type { GenericSchema } from 'valibot'

// Thin wrapper around @hono/valibot-validator that yields a consistent error
// envelope (matching the domain error handler) when a request body fails the
// contract, instead of the library default.
export function jsonBody<T extends GenericSchema>(schema: T) {
  return vValidator('json', schema, (result, c) => {
    if (!result.success) {
      return c.json(
        {
          error: {
            code: 'validation',
            message: 'Request body failed validation',
            issues: result.issues.map((issue) => ({
              path: issue.path?.map((p) => p.key).join('.'),
              message: issue.message,
            })),
          },
        },
        400,
      )
    }
  })
}
