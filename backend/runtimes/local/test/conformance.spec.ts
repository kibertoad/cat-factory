import { type ConformanceHarness, defineConformanceSuite } from '@cat-factory/conformance'
import { describe, it } from 'vitest'
import { makeConformanceApp, setupTestDb } from './harness.js'

// Run the shared cross-runtime conformance suite against the LOCAL facade (the real
// Hono app over real Postgres, built through `buildLocalContainer`). It proves the
// local composition root composes the same Core + controllers as the Node and
// Cloudflare facades — so wiring the local Docker transport + PAT token source can't
// silently drift the shared behaviour. The agent executor is the deterministic fake
// (no Docker needed). CI provides Postgres via `DATABASE_URL`; without it the suite
// skips.

const databaseUrl = process.env.DATABASE_URL

if (databaseUrl) {
  const db = await setupTestDb()
  const harness: ConformanceHarness = {
    name: 'local',
    makeApp: (agentOptions, opts) => makeConformanceApp(db, agentOptions, opts),
  }
  defineConformanceSuite(harness)
} else {
  describe.skip('[local] conformance (set DATABASE_URL to run)', () => {
    it('requires Postgres', () => {})
  })
}
