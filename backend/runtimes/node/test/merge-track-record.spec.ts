import { type ConformanceHarness, defineMergeTrackRecordSuite } from '@cat-factory/conformance'
import { describe, it } from 'vitest'
import { makeConformanceApp, setupTestDb } from './harness.js'

// The merge track record against the Node facade (real Postgres / Drizzle). Asserts the whole
// chain — classify → per-class rule → merge → effort tag → per-class SQL rollup — behaves
// identically to the Worker (D1). See backend/docs/adr/0046-merge-track-record.md.

const databaseUrl = process.env.DATABASE_URL

if (databaseUrl) {
  const db = await setupTestDb()
  const harness: ConformanceHarness = {
    name: 'node',
    makeApp: (agentOptions, opts) => makeConformanceApp(db, agentOptions, opts),
  }
  defineMergeTrackRecordSuite(harness)
} else {
  describe.skip('[node] merge track record (set DATABASE_URL to run)', () => {
    it('requires Postgres', () => {})
  })
}
