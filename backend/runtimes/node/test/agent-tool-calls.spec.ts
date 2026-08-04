import { defineAgentToolCallSuite } from '@cat-factory/conformance'
import { describe, it } from 'vitest'
import { createDrizzleRepositories } from '../src/repositories/drizzle.js'
import { setupTestDb } from './harness.js'

// Cross-runtime parity for the tool-call trajectory sink against the Node facade's real
// Drizzle/Postgres repository (the `telemetry` schema). The Cloudflare Worker runs the identical
// suite over its dedicated TELEMETRY_DB, so the two stores can't drift — which matters most for
// the ORDER assertion: a trajectory ordered by `(job_id, seq)` on one store and by insertion on
// the other reads as two different runs. CI provides Postgres via `DATABASE_URL`.

const databaseUrl = process.env.DATABASE_URL

if (databaseUrl) {
  const db = await setupTestDb()
  const clock = { now: () => Date.now() }
  defineAgentToolCallSuite(
    'node',
    () => createDrizzleRepositories(db, clock).agentToolCallRepository,
  )
} else {
  describe.skip('[node] agent tool calls (set DATABASE_URL to run)', () => {
    it('requires Postgres', () => {})
  })
}
