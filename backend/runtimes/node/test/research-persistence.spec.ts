import { defineResearchPersistenceSuite } from '@cat-factory/conformance'
import { describe, it } from 'vitest'
import {
  DrizzleFindingsRevisionRepository,
  DrizzleFindingsStoragePolicyRepository,
  DrizzleResearchDefinitionRepository,
  DrizzleResearchProjectRepository,
} from '../src/repositories/drizzle/research.js'
import { setupTestDb } from './harness.js'

// Research persistence against the Node facade's real Postgres. The Worker runs the identical
// suite over D1.
if (process.env.DATABASE_URL) {
  const db = await setupTestDb()
  defineResearchPersistenceSuite('node', () => ({
    definitions: new DrizzleResearchDefinitionRepository(db),
    projects: new DrizzleResearchProjectRepository(db),
    revisions: new DrizzleFindingsRevisionRepository(db),
    policies: new DrizzleFindingsStoragePolicyRepository(db),
  }))
} else {
  describe.skip('[node] research persistence (set DATABASE_URL to run)', () => {
    it('requires Postgres', () => {})
  })
}
