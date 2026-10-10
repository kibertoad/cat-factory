import { defineMachineNodeSuite } from '@cat-factory/conformance'
import { describe, it } from 'vitest'
import { createDrizzleRepositories } from '../src/repositories/drizzle.js'
import { setupTestDb } from './harness.js'

// Cross-runtime parity for the machine-node roster + revocation tombstones (SEC-5)
// against the Node facade's real Drizzle/Postgres repository. The Cloudflare Worker runs
// the identical suite over its D1 table, so the two stores can't drift. CI provides
// Postgres via `DATABASE_URL`.

const databaseUrl = process.env.DATABASE_URL

if (databaseUrl) {
  const db = await setupTestDb()
  const clock = { now: () => Date.now() }
  defineMachineNodeSuite('node', () => createDrizzleRepositories(db, clock).machineNodeRepository)
} else {
  describe.skip('[node] machine nodes (set DATABASE_URL to run)', () => {
    it('requires Postgres', () => {})
  })
}
