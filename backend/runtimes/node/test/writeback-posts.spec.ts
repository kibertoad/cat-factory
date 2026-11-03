import { defineWritebackPostSuite } from '@cat-factory/conformance'
import { describe, it } from 'vitest'
import { DrizzleWritebackPostRepository } from '../src/repositories/drizzle/writebackPosts.js'
import { setupTestDb } from './harness.js'

// Cross-runtime parity for the writeback exactly-once markers against the Node facade's real
// Drizzle/Postgres repository. The Worker runs the identical suite over D1.
// CI provides Postgres via `DATABASE_URL`.

const databaseUrl = process.env.DATABASE_URL

if (databaseUrl) {
  const db = await setupTestDb()
  defineWritebackPostSuite('node', () => new DrizzleWritebackPostRepository(db))
} else {
  describe.skip('[node] writeback posts (set DATABASE_URL to run)', () => {
    it('requires Postgres', () => {})
  })
}
