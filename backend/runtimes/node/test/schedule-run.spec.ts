import { defineScheduleRunSuite } from '@cat-factory/conformance'
import { describe, it } from 'vitest'
import { createDrizzleRepositories } from '../src/repositories/drizzle.js'
import { setupTestDb } from './harness.js'

// Cross-runtime parity for the recurring-pipeline run history against the Node facade's real
// Drizzle/Postgres repository. The Cloudflare Worker runs the identical suite over its D1
// table, so the two stores can't drift. CI provides Postgres via `DATABASE_URL`.

const databaseUrl = process.env.DATABASE_URL

if (databaseUrl) {
  const db = await setupTestDb()
  const clock = { now: () => Date.now() }
  defineScheduleRunSuite(
    'node',
    () => createDrizzleRepositories(db, clock).pipelineScheduleRepository,
  )
} else {
  describe.skip('[node] schedule runs (set DATABASE_URL to run)', () => {
    it('requires Postgres', () => {})
  })
}
