import { defineConsensusGroupSuite } from '@cat-factory/conformance'
import { describe, it } from 'vitest'
import { createDrizzleRepositories } from '../src/repositories/drizzle.js'
import { setupTestDb } from './harness.js'

// Cross-runtime parity for the consensus-GROUP library against the Node facade's real
// Drizzle/Postgres repository. The Cloudflare Worker runs the identical suite over its D1, so
// the two stores can't drift on the JSON `participants` / `gating` columns the tier selection
// reads. CI provides Postgres via `DATABASE_URL`.

const databaseUrl = process.env.DATABASE_URL

if (databaseUrl) {
  const db = await setupTestDb()
  const clock = { now: () => Date.now() }
  defineConsensusGroupSuite(
    'node',
    () => createDrizzleRepositories(db, clock).consensusGroupRepository,
  )
} else {
  describe.skip('[node] consensus groups (set DATABASE_URL to run)', () => {
    it('requires Postgres', () => {})
  })
}
