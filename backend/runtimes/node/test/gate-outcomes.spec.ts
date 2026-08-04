import { type GateOutcomeSeed, defineGateOutcomeSuite } from '@cat-factory/conformance'
import { describe, it } from 'vitest'
import { workspaces } from '../src/db/schema.js'
import { createDrizzleRepositories } from '../src/repositories/drizzle.js'
import { setupTestDb } from './harness.js'

// Cross-runtime parity for the settled-gate projection against the Node facade's real
// Drizzle/Postgres store. The Cloudflare Worker runs the identical suite over D1, so the two
// dialects' conflict handling and conditional aggregation can't drift. CI provides Postgres
// via `DATABASE_URL`.

const databaseUrl = process.env.DATABASE_URL

if (databaseUrl) {
  const db = await setupTestDb()
  const repos = createDrizzleRepositories(db, { now: () => Date.now() })
  const seed: GateOutcomeSeed = {
    async workspace(id, accountId) {
      await db
        .insert(workspaces)
        .values({ id, name: id, created_at: 0, account_id: accountId })
        .onConflictDoNothing()
    },
  }
  defineGateOutcomeSuite(
    'node',
    () => repos.gateOutcomeRepository,
    () => seed,
  )
} else {
  describe.skip('[node] gate outcomes (set DATABASE_URL to run)', () => {
    it('requires Postgres', () => {})
  })
}
