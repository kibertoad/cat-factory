import { defineDirectoryFeedSuite } from '@cat-factory/conformance'
import { describe, it } from 'vitest'
import { DrizzleDirectoryRepository } from '../src/repositories/directoryRepository.js'
import { createDrizzleRepositories } from '../src/repositories/drizzle.js'
import { DrizzleRepoProjectionRepository } from '../src/repositories/github.js'
import { setupTestDb } from './harness.js'

// The directory change feed against the Node facade's real Drizzle repositories. The Cloudflare
// Worker runs the identical suite over D1. CI provides Postgres via `DATABASE_URL`.

const databaseUrl = process.env.DATABASE_URL

if (databaseUrl) {
  const db = await setupTestDb()
  const clock = { now: () => Date.now() }
  defineDirectoryFeedSuite('node', () => {
    const repos = createDrizzleRepositories(db, clock)
    return {
      users: repos.userRepository,
      memberships: repos.membershipRepository,
      workspaces: repos.workspaceRepository,
      workspaceMembers: repos.workspaceMemberRepository,
      repos: new DrizzleRepoProjectionRepository(db),
      changes: new DrizzleDirectoryRepository(db),
    }
  })
} else {
  describe.skip('[node] directory feed (set DATABASE_URL to run)', () => {
    it('requires Postgres', () => {})
  })
}
