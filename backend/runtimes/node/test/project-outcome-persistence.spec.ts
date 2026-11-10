import { defineProjectOutcomePersistenceSuite } from '@cat-factory/conformance'
import { describe, it } from 'vitest'
import {
  DrizzleOutcomeStoragePolicyRepository,
  DrizzleProjectDefinitionRepository,
  DrizzleProjectRecordRepository,
} from '../src/repositories/drizzle/project-outcomes.js'
import { setupTestDb } from './harness.js'

// Project definition and outcome persistence against the Node facade's real Postgres. The Worker
// runs the identical suite over D1.
if (process.env.DATABASE_URL) {
  const db = await setupTestDb()
  defineProjectOutcomePersistenceSuite('node', () => ({
    definitions: new DrizzleProjectDefinitionRepository(db),
    records: new DrizzleProjectRecordRepository(db),
    policies: new DrizzleOutcomeStoragePolicyRepository(db),
  }))
} else {
  describe.skip('[node] project outcome persistence (set DATABASE_URL to run)', () => {
    it('requires Postgres', () => {})
  })
}
