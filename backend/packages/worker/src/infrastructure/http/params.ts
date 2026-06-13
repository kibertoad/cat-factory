import { ValidationError } from '@cat-factory/core'
import type { Context } from 'hono'

/**
 * Read a required path parameter. Controllers are mounted under a param prefix
 * (`/workspaces/:workspaceId`), so Hono types the lookup as possibly undefined;
 * a missing value would be a routing bug, surfaced here as a clear error.
 */
export function param(c: Context, name: string): string {
  const value = c.req.param(name)
  if (value === undefined) throw new ValidationError(`Missing path parameter: ${name}`)
  return value
}
