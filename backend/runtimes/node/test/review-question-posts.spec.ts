import { defineReviewQuestionPostSuite } from '@cat-factory/conformance'
import { describe, it } from 'vitest'
import { DrizzleReviewQuestionPostRepository } from '../src/repositories/drizzle/settings.js'
import { setupTestDb } from './harness.js'

// Cross-runtime parity for the question-writeback idempotency markers against the Node facade's
// real Drizzle/Postgres repository. The Cloudflare Worker runs the identical suite over D1, so the
// atomic claim — Drizzle's `onConflictDoUpdate({ setWhere })` here, `ON CONFLICT … DO UPDATE …
// WHERE … RETURNING` there — can't drift into double-posting on one store.
// CI provides Postgres via `DATABASE_URL`.

const databaseUrl = process.env.DATABASE_URL

if (databaseUrl) {
  const db = await setupTestDb()
  defineReviewQuestionPostSuite('node', () => new DrizzleReviewQuestionPostRepository(db))
} else {
  describe.skip('[node] review question posts (set DATABASE_URL to run)', () => {
    it('requires Postgres', () => {})
  })
}
