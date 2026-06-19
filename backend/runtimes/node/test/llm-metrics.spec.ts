import { defineLlmMetricsSuite } from '@cat-factory/conformance'
import { describe, it } from 'vitest'
import { createDrizzleRepositories } from '../src/repositories/drizzle.js'
import { setupTestDb } from './harness.js'

// Cross-runtime parity for the LLM observability sink against the Node facade's real
// Drizzle/Postgres repository. The Cloudflare Worker runs the identical suite over
// D1, so the two stores can't drift. CI provides Postgres via `DATABASE_URL`.

const databaseUrl = process.env.DATABASE_URL

if (databaseUrl) {
  const db = await setupTestDb()
  const clock = { now: () => Date.now() }
  defineLlmMetricsSuite('node', () => createDrizzleRepositories(db, clock).llmCallMetricRepository)
} else {
  describe.skip('[node] llm metrics (set DATABASE_URL to run)', () => {
    it('requires Postgres', () => {})
  })
}
