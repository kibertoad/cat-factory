import { defineNotificationWebhookSuite } from '@cat-factory/conformance'
import { describe, it } from 'vitest'
import { DrizzleNotificationWebhookRepository } from '../src/repositories/drizzle/settings.js'
import { setupTestDb } from './harness.js'

// Cross-runtime parity for the outbound notification-webhook store against the Node facade's real
// Drizzle/Postgres repository. The Cloudflare Worker runs the identical suite over D1, so the two
// stores — and the `types` JSON column both decode through the shared parser — can't drift.
// CI provides Postgres via `DATABASE_URL`.

const databaseUrl = process.env.DATABASE_URL

if (databaseUrl) {
  const db = await setupTestDb()
  defineNotificationWebhookSuite('node', () => new DrizzleNotificationWebhookRepository(db))
} else {
  describe.skip('[node] notification webhooks (set DATABASE_URL to run)', () => {
    it('requires Postgres', () => {})
  })
}
