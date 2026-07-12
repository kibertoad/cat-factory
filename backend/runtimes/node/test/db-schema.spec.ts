import { isConfigValidationError } from '@cat-factory/server'
import { describe, expect, it } from 'vitest'
import { DEFAULT_DB_SCHEMA, resolveDbSchema } from '../src/db/client.js'

// `resolveDbSchema` validates the configurable Postgres schema names (DB_SCHEMA /
// DB_MIGRATIONS_SCHEMA) that get interpolated into non-parameterizable SQL. An invalid value
// must surface as a ConfigValidationError — it runs inside the boot try/catch (createDbClient +
// migrate), so the misconfiguration fallback screen serves it instead of the process
// hard-crashing with an opaque message the operator can't act on.
describe('resolveDbSchema', () => {
  it('returns the trimmed value for a valid lowercase identifier', () => {
    expect(resolveDbSchema('  my_schema  ')).toBe('my_schema')
  })

  it('falls back to the default when unset or blank', () => {
    expect(resolveDbSchema(undefined)).toBe(DEFAULT_DB_SCHEMA)
    expect(resolveDbSchema('   ')).toBe(DEFAULT_DB_SCHEMA)
    expect(resolveDbSchema(undefined, 'drizzle', 'DB_MIGRATIONS_SCHEMA')).toBe('drizzle')
  })

  it('throws a ConfigValidationError (not a bare Error) for an invalid identifier', () => {
    try {
      resolveDbSchema('Bad-Schema!', 'public', 'DB_SCHEMA')
      expect.unreachable('should have thrown')
    } catch (err) {
      expect(isConfigValidationError(err)).toBe(true)
      const problem = (err as { problems: { key: string; remedy: string; docsUrl?: string }[] })
        .problems[0]!
      expect(problem.key).toBe('DB_SCHEMA')
      expect(problem.remedy).toMatch(/lowercase identifier/)
      expect(problem.docsUrl).toMatch(/environment-variables/)
    }
  })

  it('names the supplied label in the problem (DB_MIGRATIONS_SCHEMA)', () => {
    try {
      resolveDbSchema('9nope', 'drizzle', 'DB_MIGRATIONS_SCHEMA')
      expect.unreachable('should have thrown')
    } catch (err) {
      expect(isConfigValidationError(err)).toBe(true)
      expect((err as { problems: { key: string }[] }).problems[0]!.key).toBe('DB_MIGRATIONS_SCHEMA')
    }
  })
})
