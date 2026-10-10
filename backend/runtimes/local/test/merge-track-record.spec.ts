import { type ConformanceHarness, defineMergeTrackRecordSuite } from '@cat-factory/conformance'
import { describe, it } from 'vitest'
import { makeConformanceApp, setupTestDb } from './harness.js'

// The merge track record against the LOCAL facade (Node persistence built through
// buildLocalContainer), so the local wiring of the track-record repository + the classification
// seam can't drift from the Node/Worker facades. See backend/docs/adr/0046-merge-track-record.md.

const databaseUrl = process.env.DATABASE_URL

if (databaseUrl) {
  const db = await setupTestDb()
  const harness: ConformanceHarness = {
    name: 'local',
    makeApp: (agentOptions, opts) => makeConformanceApp(db, agentOptions, opts),
  }
  defineMergeTrackRecordSuite(harness)
} else {
  describe.skip('[local] merge track record (set DATABASE_URL to run)', () => {
    it('requires Postgres', () => {})
  })
}
