import { defineAgentContextSuite } from '@cat-factory/conformance'
import { describe, it } from 'vitest'
import { createDrizzleRepositories } from '../src/repositories/drizzle.js'
import { setupTestDb } from './harness.js'

// Cross-runtime parity for the agent-context observability sink against the Node
// facade's real Drizzle/Postgres repository (the `telemetry` schema). The Cloudflare
// Worker runs the identical suite over its dedicated TELEMETRY_DB, so the two stores
// can't drift. CI provides Postgres via `DATABASE_URL`.

const databaseUrl = process.env.DATABASE_URL

if (databaseUrl) {
  const db = await setupTestDb()
  const clock = { now: () => Date.now() }
  defineAgentContextSuite(
    'node',
    () => createDrizzleRepositories(db, clock).agentContextSnapshotRepository,
  )
} else {
  describe.skip('[node] agent context (set DATABASE_URL to run)', () => {
    it('requires Postgres', () => {})
  })
}
