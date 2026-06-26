import { type ConformanceHarness, defineIntegrationConformance } from '@cat-factory/conformance'
import { describe, it } from 'vitest'
import { makeConformanceApp, setupTestDb } from './harness.js'

// Integration slice (credentials / presets / sources / environments / slack) of the shared
// conformance suite against the Node facade. See conformance.core.spec.ts for the rationale.

const databaseUrl = process.env.DATABASE_URL

if (databaseUrl) {
  const db = await setupTestDb()
  const harness: ConformanceHarness = {
    name: 'node',
    makeApp: (agentOptions, opts) => makeConformanceApp(db, agentOptions, opts),
  }
  defineIntegrationConformance(harness)
} else {
  describe.skip('[node] conformance integration (set DATABASE_URL to run)', () => {
    it('requires Postgres', () => {})
  })
}
