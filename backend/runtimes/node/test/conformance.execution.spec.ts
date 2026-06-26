import { type ConformanceHarness, defineExecutionConformance } from '@cat-factory/conformance'
import { describe, it } from 'vitest'
import { makeConformanceApp, setupTestDb } from './harness.js'

// Execution-engine slice of the shared conformance suite against the Node facade — the
// largest group, isolated into its own file so it is the long pole of a parallel run rather
// than serialised behind every other group. See conformance.core.spec.ts for the rationale.

const databaseUrl = process.env.DATABASE_URL

if (databaseUrl) {
  const db = await setupTestDb()
  const harness: ConformanceHarness = {
    name: 'node',
    makeApp: (agentOptions, opts) => makeConformanceApp(db, agentOptions, opts),
  }
  defineExecutionConformance(harness)
} else {
  describe.skip('[node] conformance execution (set DATABASE_URL to run)', () => {
    it('requires Postgres', () => {})
  })
}
