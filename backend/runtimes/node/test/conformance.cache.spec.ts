import { type ConformanceHarness, defineCacheSuite } from '@cat-factory/conformance'
import { describe, it } from 'vitest'
import { makeConformanceApp, setupTestDb } from './harness.js'

// Caching-initiative slice of the shared conformance suite against the Node facade:
// write-then-read coherence of the cached fragment catalog (see cache-suite.ts).

const databaseUrl = process.env.DATABASE_URL

if (databaseUrl) {
  const db = await setupTestDb()
  const harness: ConformanceHarness = {
    name: 'node',
    makeApp: (agentOptions, opts) => makeConformanceApp(db, agentOptions, opts),
  }
  defineCacheSuite(harness)
} else {
  describe.skip('[node] conformance cache (set DATABASE_URL to run)', () => {
    it('requires Postgres', () => {})
  })
}
