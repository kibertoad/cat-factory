import { defineNotificationSettingsSuite } from '@cat-factory/conformance'
import { describe, it } from 'vitest'
import { DrizzleNotificationSettingsRepository } from '../src/repositories/notifications.js'
import { setupTestDb } from './harness.js'

// Cross-runtime parity for the notification manager's routing store against the Node facade's
// real Drizzle/Postgres store. The Cloudflare Worker runs the identical suite over D1, so the
// two dialects' conflict handling and JSON round trip can't drift. CI provides Postgres via
// `DATABASE_URL`.

const databaseUrl = process.env.DATABASE_URL

if (databaseUrl) {
  const db = await setupTestDb()
  defineNotificationSettingsSuite('node', () => new DrizzleNotificationSettingsRepository(db))
} else {
  describe.skip('[node] notification settings (set DATABASE_URL to run)', () => {
    it('requires Postgres', () => {})
  })
}
