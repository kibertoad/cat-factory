import { type ConformanceHarness, defineReviewFrictionSuite } from '@cat-factory/conformance'
import { describe, it } from 'vitest'
import { makeConformanceApp, setupTestDb } from './harness.js'

// Opt-in review-debt friction on task creation, against the Node facade. Asserts the four new
// `workspace_settings` columns + the board's friction guard gate task creation identically to the
// Worker (D1). See backend/docs/review-debt-friction.md.

const databaseUrl = process.env.DATABASE_URL

if (databaseUrl) {
  const db = await setupTestDb()
  const harness: ConformanceHarness = {
    name: 'node',
    makeApp: (agentOptions, opts) => makeConformanceApp(db, agentOptions, opts),
  }
  defineReviewFrictionSuite(harness)
} else {
  describe.skip('[node] review-debt friction (set DATABASE_URL to run)', () => {
    it('requires Postgres', () => {})
  })
}
