import {
  type ConformanceHarness,
  defineWorkspaceAccessSuite,
  defineWorkspaceRbacSuite,
} from '@cat-factory/conformance'
import { describe, it } from 'vitest'
import { makeConformanceApp, setupTestDb } from './harness.js'

// Cross-runtime parity for workspace RBAC (workspace-rbac initiative) against the Node facade's
// real Drizzle/Postgres store: the slice-2 persistence (`workspace_members` roster + `access_mode`
// column) AND the slice-3 HTTP enforcement (gate resolution + viewer floor + list filtering). The
// Cloudflare Worker runs the identical suites over its D1 tables, so neither can drift. CI provides
// Postgres via `DATABASE_URL`.

const databaseUrl = process.env.DATABASE_URL

if (databaseUrl) {
  const db = await setupTestDb()
  const harness: ConformanceHarness = {
    name: 'node',
    makeApp: (agentOptions, opts) => makeConformanceApp(db, agentOptions, opts),
  }
  defineWorkspaceAccessSuite(harness)
  defineWorkspaceRbacSuite(harness)
} else {
  describe.skip('[node] workspace access (set DATABASE_URL to run)', () => {
    it('requires Postgres', () => {})
  })
}
