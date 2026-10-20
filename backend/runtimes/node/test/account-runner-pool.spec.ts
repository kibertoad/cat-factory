import { defineAccountRunnerPoolSuite } from '@cat-factory/conformance'
import { describe, it } from 'vitest'
import { DrizzleAccountRunnerPoolRepository } from '../src/repositories/containerExecution.js'
import { createDrizzleRepositories } from '../src/repositories/drizzle.js'
import { setupTestDb } from './harness.js'

// Cross-runtime parity for the account tier of the runner pool against the Node facade's real
// Drizzle/Postgres repositories. The Worker runs the identical suite over D1. CI provides Postgres
// via `DATABASE_URL`.

const databaseUrl = process.env.DATABASE_URL

if (databaseUrl) {
  const db = await setupTestDb()
  const clock = { now: () => Date.now() }
  defineAccountRunnerPoolSuite('node', () => ({
    pools: new DrizzleAccountRunnerPoolRepository(db),
    accounts: createDrizzleRepositories(db, clock).accountRepository,
  }))
} else {
  describe.skip('[node] account runner pool (set DATABASE_URL to run)', () => {
    it('requires Postgres', () => {})
  })
}
