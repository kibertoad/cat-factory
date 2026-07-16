import { type ConformanceHarness, defineWorkspaceAccessSuite } from '@cat-factory/conformance'
import { describe, it } from 'vitest'
import { makeConformanceApp, setupTestDb } from './harness.js'

// Cross-runtime parity for the workspace-RBAC persistence (workspace-rbac initiative, slice 2)
// against the Node facade's real Drizzle/Postgres store. The Cloudflare Worker runs the
// identical suite over its D1 tables, so the `workspace_members` roster + `access_mode` column
// can't drift. CI provides Postgres via `DATABASE_URL`.

const databaseUrl = process.env.DATABASE_URL

if (databaseUrl) {
  const db = await setupTestDb()
  const harness: ConformanceHarness = {
    name: 'node',
    makeApp: (agentOptions, opts) => makeConformanceApp(db, agentOptions, opts),
  }
  defineWorkspaceAccessSuite(harness)
} else {
  describe.skip('[node] workspace access (set DATABASE_URL to run)', () => {
    it('requires Postgres', () => {})
  })
}
