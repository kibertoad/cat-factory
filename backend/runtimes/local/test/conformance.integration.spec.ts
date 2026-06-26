import { type ConformanceHarness, defineIntegrationConformance } from '@cat-factory/conformance'
import { describe, it } from 'vitest'
import { makeConformanceApp, setupTestDb } from './harness.js'

// Integration slice (credentials / presets / sources / environments / slack) of the shared
// conformance suite against the LOCAL facade. See conformance.core.spec.ts for the rationale.

const databaseUrl = process.env.DATABASE_URL

if (databaseUrl) {
  const db = await setupTestDb()
  const harness: ConformanceHarness = {
    name: 'local',
    makeApp: (agentOptions, opts) => makeConformanceApp(db, agentOptions, opts),
  }
  defineIntegrationConformance(harness)
} else {
  describe.skip('[local] conformance integration (set DATABASE_URL to run)', () => {
    it('requires Postgres', () => {})
  })
}
