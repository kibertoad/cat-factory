import { type ConformanceHarness, defineMiscConformance } from '@cat-factory/conformance'
import { describe, it } from 'vitest'
import { makeConformanceApp, setupTestDb } from './harness.js'

// Recurring-pipelines / slack / identity slice of the shared conformance suite against the
// Node facade. See conformance.core.spec.ts for the split rationale.

const databaseUrl = process.env.DATABASE_URL

if (databaseUrl) {
  const db = await setupTestDb()
  const harness: ConformanceHarness = {
    name: 'node',
    makeApp: (agentOptions, opts) => makeConformanceApp(db, agentOptions, opts),
  }
  defineMiscConformance(harness)
} else {
  describe.skip('[node] conformance misc (set DATABASE_URL to run)', () => {
    it('requires Postgres', () => {})
  })
}
