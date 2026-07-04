import { type ConformanceHarness, defineCacheSuite } from '@cat-factory/conformance'
import { describe, it } from 'vitest'
import { makeConformanceApp, setupTestDb } from './harness.js'

// Caching-initiative slice of the shared conformance suite against the LOCAL facade:
// write-then-read coherence of the cached fragment catalog (see cache-suite.ts). The
// local facade builds through buildLocalContainer, so its (bare in-memory, single-node
// by construction) cache wiring is what runs here.

const databaseUrl = process.env.DATABASE_URL

if (databaseUrl) {
  const db = await setupTestDb()
  const harness: ConformanceHarness = {
    name: 'local',
    makeApp: (agentOptions, opts) => makeConformanceApp(db, agentOptions, opts),
  }
  defineCacheSuite(harness)
} else {
  describe.skip('[local] conformance cache (set DATABASE_URL to run)', () => {
    it('requires Postgres', () => {})
  })
}
