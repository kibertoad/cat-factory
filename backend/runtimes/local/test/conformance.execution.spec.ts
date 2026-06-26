import { type ConformanceHarness, defineExecutionConformance } from '@cat-factory/conformance'
import { describe, it } from 'vitest'
import { makeConformanceApp, setupTestDb } from './harness.js'

// Execution-engine slice of the shared conformance suite against the LOCAL facade — the
// largest group, isolated into its own file so it is the long pole of a parallel run.
// See conformance.core.spec.ts for the split rationale.

const databaseUrl = process.env.DATABASE_URL

if (databaseUrl) {
  const db = await setupTestDb()
  const harness: ConformanceHarness = {
    name: 'local',
    makeApp: (agentOptions, opts) => makeConformanceApp(db, agentOptions, opts),
  }
  defineExecutionConformance(harness)
} else {
  describe.skip('[local] conformance execution (set DATABASE_URL to run)', () => {
    it('requires Postgres', () => {})
  })
}
