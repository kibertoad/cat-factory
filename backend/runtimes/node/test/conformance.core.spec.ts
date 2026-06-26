import { type ConformanceHarness, defineCoreConformance } from '@cat-factory/conformance'
import { describe, it } from 'vitest'
import { makeConformanceApp, setupTestDb } from './harness.js'

// One slice of the shared cross-runtime conformance suite against the Node facade (real
// Hono app over real Postgres). The suite is split into per-group spec files so they run
// in parallel across vitest workers, each on its own per-worker database. CI provides
// Postgres via `DATABASE_URL`; without it the slice skips.

const databaseUrl = process.env.DATABASE_URL

if (databaseUrl) {
  const db = await setupTestDb()
  const harness: ConformanceHarness = {
    name: 'node',
    makeApp: (agentOptions, opts) => makeConformanceApp(db, agentOptions, opts),
  }
  defineCoreConformance(harness)
} else {
  describe.skip('[node] conformance core (set DATABASE_URL to run)', () => {
    it('requires Postgres', () => {})
  })
}
