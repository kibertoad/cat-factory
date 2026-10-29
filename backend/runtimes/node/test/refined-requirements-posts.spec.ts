import { defineRefinedRequirementsPostSuite } from '@cat-factory/conformance'
import { describe, it } from 'vitest'
import { DrizzleRefinedRequirementsPostRepository } from '../src/repositories/drizzle/refinedRequirementsPosts.js'
import { setupTestDb } from './harness.js'

// Cross-runtime parity for the refined-requirements post markers against the Node facade's real
// Drizzle/Postgres repository. The Worker runs the identical suite over D1.

const databaseUrl = process.env.DATABASE_URL

if (databaseUrl) {
  const db = await setupTestDb()
  defineRefinedRequirementsPostSuite('node', () => new DrizzleRefinedRequirementsPostRepository(db))
} else {
  describe.skip('[node] refined requirements posts (set DATABASE_URL to run)', () => {
    it('requires Postgres', () => {})
  })
}
