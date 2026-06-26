import { type ConformanceHarness, defineCoreConformance } from '@cat-factory/conformance'
import { describe, it } from 'vitest'
import { makeConformanceApp, setupTestDb } from './harness.js'

// One slice of the shared cross-runtime conformance suite against the LOCAL facade (built
// through buildLocalContainer over real Postgres). Split into per-group spec files so they
// run in parallel across vitest workers, each on its own per-worker database.

const databaseUrl = process.env.DATABASE_URL

if (databaseUrl) {
  const db = await setupTestDb()
  const harness: ConformanceHarness = {
    name: 'local',
    makeApp: (agentOptions, opts) => makeConformanceApp(db, agentOptions, opts),
  }
  defineCoreConformance(harness)
} else {
  describe.skip('[local] conformance core (set DATABASE_URL to run)', () => {
    it('requires Postgres', () => {})
  })
}
