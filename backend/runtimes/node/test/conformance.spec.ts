import { type ConformanceHarness, defineConformanceSuite } from '@cat-factory/conformance'
import { describe, it } from 'vitest'
import { makeConformanceApp, setupTestDb } from './harness.js'

// Run the shared cross-runtime conformance suite against the Node facade (the real
// Hono app over real Postgres). The Cloudflare Worker runs the identical suite over
// D1 — together they mandate feature parity across runtimes. CI provides Postgres via
// `DATABASE_URL`; without it (e.g. a local `pnpm -r test` with no DB) the suite skips.

const databaseUrl = process.env.DATABASE_URL

if (databaseUrl) {
  const db = await setupTestDb()
  const harness: ConformanceHarness = {
    name: 'node',
    makeApp: (agentOptions) => makeConformanceApp(db, agentOptions),
  }
  defineConformanceSuite(harness)
} else {
  describe.skip('[node] conformance (set DATABASE_URL to run)', () => {
    it('requires Postgres', () => {})
  })
}
