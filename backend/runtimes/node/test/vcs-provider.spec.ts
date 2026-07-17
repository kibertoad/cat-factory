import { defineVcsProviderSuite } from '@cat-factory/conformance'
import { describe, it } from 'vitest'
import { DrizzleGitHubInstallationRepository } from '../src/repositories/containerExecution.js'
import { DrizzleRepoProjectionRepository } from '../src/repositories/github.js'
import { setupTestDb } from './harness.js'

// Cross-runtime parity for the `provider` VCS discriminator on the Node facade's real
// Drizzle/Postgres projection tables. The Cloudflare Worker runs the identical suite over its
// D1 tables, so the two stores can't drift. CI provides Postgres via `DATABASE_URL`.

const databaseUrl = process.env.DATABASE_URL

if (databaseUrl) {
  const db = await setupTestDb()
  defineVcsProviderSuite('node', () => ({
    installations: new DrizzleGitHubInstallationRepository(db),
    repoProjection: new DrizzleRepoProjectionRepository(db),
  }))
} else {
  describe.skip('[node] VCS provider projection (set DATABASE_URL to run)', () => {
    it('requires Postgres', () => {})
  })
}
