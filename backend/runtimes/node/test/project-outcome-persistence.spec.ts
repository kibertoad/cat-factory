import { defineProjectOutcomePersistenceSuite } from '@cat-factory/conformance'
import { describe, it } from 'vitest'
import { createDrizzleRepositories } from '../src/repositories/drizzle.js'
import { setupTestDb } from './harness.js'

// Project definition and outcome persistence against the Node facade's real Postgres. The Worker
// runs the identical suite over D1.
if (process.env.DATABASE_URL) {
  const db = await setupTestDb()
  defineProjectOutcomePersistenceSuite('node', () => {
    const repos = createDrizzleRepositories(db, { now: () => 0 })
    return {
      definitions: repos.projectDefinitionRepository,
      records: repos.projectRecordRepository,
      policies: repos.outcomeStoragePolicyRepository,
      board: {
        workspaces: repos.workspaceRepository,
        blocks: repos.blockRepository,
        projects: repos.projectRepository,
      },
    }
  })
} else {
  describe.skip('[node] project outcome persistence (set DATABASE_URL to run)', () => {
    it('requires Postgres', () => {})
  })
}
