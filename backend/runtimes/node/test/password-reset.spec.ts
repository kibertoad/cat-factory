import { definePasswordResetTokenSuite } from '@cat-factory/conformance'
import { describe, it } from 'vitest'
import { createDrizzleRepositories } from '../src/repositories/drizzle.js'
import { setupTestDb } from './harness.js'

// Cross-runtime parity for the password-reset token store against the Node facade's real
// Drizzle/Postgres repository. The Cloudflare Worker runs the identical suite over its
// D1 table, so the two stores can't drift. CI provides Postgres via `DATABASE_URL`.

const databaseUrl = process.env.DATABASE_URL

if (databaseUrl) {
  const db = await setupTestDb()
  const clock = { now: () => Date.now() }
  definePasswordResetTokenSuite(
    'node',
    () => createDrizzleRepositories(db, clock).passwordResetTokenRepository,
  )
} else {
  describe.skip('[node] password reset (set DATABASE_URL to run)', () => {
    it('requires Postgres', () => {})
  })
}
