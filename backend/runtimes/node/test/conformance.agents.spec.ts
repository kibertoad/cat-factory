import { type ConformanceHarness, defineAgentConformance } from '@cat-factory/conformance'
import { describe, it } from 'vitest'
import { makeConformanceApp, setupTestDb } from './harness.js'

// Agent/gate slice of the shared conformance suite against the Node facade. See
// conformance.core.spec.ts for the split rationale.

const databaseUrl = process.env.DATABASE_URL

if (databaseUrl) {
  const db = await setupTestDb()
  const harness: ConformanceHarness = {
    name: 'node',
    makeApp: (agentOptions, opts) => makeConformanceApp(db, agentOptions, opts),
  }
  defineAgentConformance(harness)
} else {
  describe.skip('[node] conformance agents (set DATABASE_URL to run)', () => {
    it('requires Postgres', () => {})
  })
}
