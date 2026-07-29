import { defineAgentPromptSuite } from '@cat-factory/conformance'
import { describe, it } from 'vitest'
import { createDrizzleRepositories } from '../src/repositories/drizzle.js'
import { setupTestDb } from './harness.js'

// Cross-runtime parity for the agent system-prompt override log against the Node facade's real
// Drizzle/Postgres repository. The Cloudflare Worker runs the identical suite over its D1, so
// the two stores can't drift on the nullable `text`, the head resolution or the duplicate-
// revision refusal. CI provides Postgres via `DATABASE_URL`.

const databaseUrl = process.env.DATABASE_URL

if (databaseUrl) {
  const db = await setupTestDb()
  const clock = { now: () => Date.now() }
  defineAgentPromptSuite('node', () => createDrizzleRepositories(db, clock).agentPromptRepository)
} else {
  describe.skip('[node] agent prompts (set DATABASE_URL to run)', () => {
    it('requires Postgres', () => {})
  })
}
