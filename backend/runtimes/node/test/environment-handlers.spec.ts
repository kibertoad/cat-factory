import { defineEnvironmentHandlersSuite } from '@cat-factory/conformance'
import { describe, it } from 'vitest'
import { DrizzleCustomManifestTypeRepository } from '../src/repositories/customManifestType.js'
import { DrizzleEnvironmentUserHandlerRepository } from '../src/repositories/environmentUserHandler.js'
import { setupTestDb } from './harness.js'

// Cross-runtime parity for the per-service provision-type persistence against the Node
// facade's real Drizzle/Postgres repositories. The Cloudflare Worker runs the identical
// suite over its D1 database, so the two stores can't drift. CI provides Postgres via
// `DATABASE_URL`.

const databaseUrl = process.env.DATABASE_URL

if (databaseUrl) {
  const db = await setupTestDb()
  defineEnvironmentHandlersSuite('node', () => ({
    userHandlers: new DrizzleEnvironmentUserHandlerRepository(db),
    customTypes: new DrizzleCustomManifestTypeRepository(db),
  }))
} else {
  describe.skip('[node] environment handlers (set DATABASE_URL to run)', () => {
    it('requires Postgres', () => {})
  })
}
