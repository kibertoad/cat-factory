import { defineInitiativeSuite } from '@cat-factory/conformance'
import { describe, it } from 'vitest'
import { createDrizzleRepositories } from '../src/repositories/drizzle.js'
import { setupTestDb } from './harness.js'

// Cross-runtime parity for the initiative store against the Node facade's real
// Drizzle/Postgres repositories. The Cloudflare Worker runs the identical suite over
// its D1, so the two stores can't drift. CI provides Postgres via `DATABASE_URL`.

const databaseUrl = process.env.DATABASE_URL

if (databaseUrl) {
  const db = await setupTestDb()
  const clock = { now: () => Date.now() }
  defineInitiativeSuite('node', () => {
    const repos = createDrizzleRepositories(db, clock)
    return { initiatives: repos.initiativeRepository, blocks: repos.blockRepository }
  })
} else {
  describe.skip('[node] initiative (set DATABASE_URL to run)', () => {
    it('requires Postgres', () => {})
  })
}
