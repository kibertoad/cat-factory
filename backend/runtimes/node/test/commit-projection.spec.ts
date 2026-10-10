import { defineCommitProjectionSuite } from '@cat-factory/conformance'
import { describe, it } from 'vitest'
import { DrizzleCommitProjectionRepository } from '../src/repositories/github.js'
import { setupTestDb } from './harness.js'

// Cross-runtime parity for the github_commits projection against the Node facade's real
// Drizzle/Postgres repository. The Cloudflare Worker runs the identical suite over its D1
// table, so the two stores can't drift. CI provides Postgres via `DATABASE_URL`.

const databaseUrl = process.env.DATABASE_URL

if (databaseUrl) {
  const db = await setupTestDb()
  defineCommitProjectionSuite('node', () => new DrizzleCommitProjectionRepository(db))
} else {
  describe.skip('[node] commit projection (set DATABASE_URL to run)', () => {
    it('requires Postgres', () => {})
  })
}
