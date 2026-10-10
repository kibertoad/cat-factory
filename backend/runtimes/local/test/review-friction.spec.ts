import { type ConformanceHarness, defineReviewFrictionSuite } from '@cat-factory/conformance'
import { describe, it } from 'vitest'
import { makeConformanceApp, setupTestDb } from './harness.js'

// Opt-in review-debt friction on task creation, against the LOCAL facade (Node persistence built
// through buildLocalContainer). See backend/docs/review-debt-friction.md.

const databaseUrl = process.env.DATABASE_URL

if (databaseUrl) {
  const db = await setupTestDb()
  const harness: ConformanceHarness = {
    name: 'local',
    makeApp: (agentOptions, opts) => makeConformanceApp(db, agentOptions, opts),
  }
  defineReviewFrictionSuite(harness)
} else {
  describe.skip('[local] review-debt friction (set DATABASE_URL to run)', () => {
    it('requires Postgres', () => {})
  })
}
