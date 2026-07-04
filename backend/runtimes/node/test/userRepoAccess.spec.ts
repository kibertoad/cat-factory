import { defineUserRepoAccessSuite } from '@cat-factory/conformance'
import { beforeAll } from 'vitest'
import type { DrizzleDb } from '../src/db/client.js'
import { DrizzleUserRepoAccessRepository } from '../src/repositories/userRepoAccess.js'
import { setupTestDb } from './harness.js'

// Node's real Drizzle/Postgres user-repo-access repo, run through the shared cross-runtime
// parity suite (the Worker runs the same suite over its D1 repo).
let db: DrizzleDb
beforeAll(async () => {
  db = await setupTestDb()
})
defineUserRepoAccessSuite('node', () => new DrizzleUserRepoAccessRepository(db))
