import { defineSubscriptionQuotaSuite } from '@cat-factory/conformance'
import { describe, it } from 'vitest'
import { createDrizzleRepositories } from '../src/repositories/drizzle.js'
import { setupTestDb } from './harness.js'

// Cross-runtime parity for the subscription quota-cycle store against the Node facade's
// real Drizzle/Postgres repository. The Cloudflare Worker runs the identical suite over
// D1, so the two stores can't drift. CI provides Postgres via `DATABASE_URL`.

const databaseUrl = process.env.DATABASE_URL

if (databaseUrl) {
  const db = await setupTestDb()
  const clock = { now: () => Date.now() }
  defineSubscriptionQuotaSuite(
    'node',
    () => createDrizzleRepositories(db, clock).subscriptionQuotaCycleRepository,
  )
} else {
  describe.skip('[node] subscription quota (set DATABASE_URL to run)', () => {
    it('requires Postgres', () => {})
  })
}
