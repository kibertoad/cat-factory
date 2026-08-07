import { defineAuditEventSuite, defineSessionGenerationSuite } from '@cat-factory/conformance'
import { describe, it } from 'vitest'
import { createDrizzleRepositories } from '../src/repositories/drizzle.js'
import { setupTestDb } from './harness.js'

// Cross-runtime parity for the append-only account audit log against the Node facade's real
// Drizzle/Postgres repository. The Cloudflare Worker runs the identical suite over its D1 table,
// so the actor-column mapping and the keyset pagination can't drift between the two stores. CI
// provides Postgres via `DATABASE_URL`.

const databaseUrl = process.env.DATABASE_URL

if (databaseUrl) {
  const db = await setupTestDb()
  const clock = { now: () => Date.now() }
  defineAuditEventSuite('node', () => createDrizzleRepositories(db, clock).auditEventRepository)
  // The session-generation column rides along here rather than in a file of its own: it is the
  // other half of the same enterprise-offboarding story (the audit log records the revocation,
  // the generation performs it) and shares the one Postgres fixture.
  defineSessionGenerationSuite('node', () => createDrizzleRepositories(db, clock).userRepository)
} else {
  describe.skip('[node] audit events (set DATABASE_URL to run)', () => {
    it('requires Postgres', () => {})
  })
}
