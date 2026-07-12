import { defineEnvironmentTestSuite } from '@cat-factory/conformance'
import { describe, it } from 'vitest'
import { DrizzleEnvironmentTestRunRepository } from '../src/repositories/environmentTest.js'
import { setupTestDb } from './harness.js'

// Cross-runtime parity for the ephemeral-environment self-test run store against the Node
// facade's real Drizzle/Postgres repository. The Cloudflare Worker runs the identical suite
// over D1, so the two stores can't drift. CI provides Postgres via `DATABASE_URL`.

const databaseUrl = process.env.DATABASE_URL

if (databaseUrl) {
  const db = await setupTestDb()
  defineEnvironmentTestSuite('node', () => new DrizzleEnvironmentTestRunRepository(db))
} else {
  describe.skip('[node] environment-test (set DATABASE_URL to run)', () => {
    it('requires Postgres', () => {})
  })
}
