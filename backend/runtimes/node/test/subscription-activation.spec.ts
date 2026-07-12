import { defineSubscriptionActivationSuite } from '@cat-factory/conformance'
import { describe, it } from 'vitest'
import { createDrizzleRepositories } from '../src/repositories/drizzle.js'
import { DrizzleSubscriptionActivationRepository } from '../src/repositories/personalSubscription.js'
import { setupTestDb } from './harness.js'

// Cross-runtime parity for the per-run subscription-activation store against the Node
// facade's real Drizzle/Postgres repository. The Cloudflare Worker runs the identical suite
// over its D1 table, so the two stores can't drift. The `user_id` FK needs a real users row,
// so the factory hands back a UserRepository too. CI provides Postgres via `DATABASE_URL`.

const databaseUrl = process.env.DATABASE_URL

if (databaseUrl) {
  const db = await setupTestDb()
  const clock = { now: () => Date.now() }
  defineSubscriptionActivationSuite('node', () => ({
    activations: new DrizzleSubscriptionActivationRepository(db),
    users: createDrizzleRepositories(db, clock).userRepository,
  }))
} else {
  describe.skip('[node] subscription activations (set DATABASE_URL to run)', () => {
    it('requires Postgres', () => {})
  })
}
