import { defineNotificationSuite } from '@cat-factory/conformance'
import { describe, it } from 'vitest'
import { DrizzleNotificationRepository } from '../src/repositories/notifications.js'
import { setupTestDb } from './harness.js'

// Cross-runtime parity for the notifications store against the Node facade's real
// Drizzle/Postgres repository. The Cloudflare Worker runs the identical suite over D1, so
// the two stores — and the retention prune wired onto both facades' sweeps — can't drift.
// CI provides Postgres via `DATABASE_URL`.

const databaseUrl = process.env.DATABASE_URL

if (databaseUrl) {
  const db = await setupTestDb()
  defineNotificationSuite('node', () => new DrizzleNotificationRepository(db))
} else {
  describe.skip('[node] notifications (set DATABASE_URL to run)', () => {
    it('requires Postgres', () => {})
  })
}
