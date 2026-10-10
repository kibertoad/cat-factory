import { defineFoundationalServicesSuite } from '@cat-factory/conformance'
import { describe, it } from 'vitest'
import {
  DrizzleApiContractRepository,
  DrizzleFoundationalServiceRepository,
  DrizzleFoundationalServiceSourceRepository,
} from '../src/repositories/foundationalServices.js'
import { DrizzleServiceCatalogConnectionRepository } from '../src/repositories/drizzle/serviceCatalog.js'
import { setupTestDb } from './harness.js'

// Cross-runtime parity for the foundational-services catalog against the Node facade's real
// Drizzle/Postgres repositories. The Cloudflare Worker runs the identical suite over its D1
// tables, so the two stores can't drift. CI provides Postgres via `DATABASE_URL`.

const databaseUrl = process.env.DATABASE_URL

if (databaseUrl) {
  const db = await setupTestDb()
  defineFoundationalServicesSuite('node', () => ({
    services: new DrizzleFoundationalServiceRepository(db),
    contracts: new DrizzleApiContractRepository(db),
    sources: new DrizzleFoundationalServiceSourceRepository(db),
    serviceCatalog: new DrizzleServiceCatalogConnectionRepository(db),
  }))
} else {
  describe.skip('[node] foundational services (set DATABASE_URL to run)', () => {
    it('requires Postgres', () => {})
  })
}
