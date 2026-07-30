import { defineAgentSettingsSuite } from '@cat-factory/conformance'
import { describe, it } from 'vitest'
import { createDrizzleRepositories } from '../src/repositories/drizzle.js'
import { setupTestDb } from './harness.js'

// Cross-runtime parity for the per-agent-kind generation-settings store against the Node facade's
// real Drizzle/Postgres repository. The Cloudflare Worker runs the identical suite over its D1, so
// the two stores can't drift on the replacing upsert, the numeric round-trip of the ceiling, or
// the workspace scoping. CI provides Postgres via `DATABASE_URL`.

const databaseUrl = process.env.DATABASE_URL

if (databaseUrl) {
  const db = await setupTestDb()
  const clock = { now: () => Date.now() }
  defineAgentSettingsSuite(
    'node',
    () => createDrizzleRepositories(db, clock).workspaceAgentSettingsRepository,
  )
} else {
  describe.skip('[node] agent settings (set DATABASE_URL to run)', () => {
    it('requires Postgres', () => {})
  })
}
