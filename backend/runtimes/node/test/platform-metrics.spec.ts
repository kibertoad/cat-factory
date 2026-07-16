import { type PlatformMetricsSeed, definePlatformMetricsSuite } from '@cat-factory/conformance'
import { describe, it } from 'vitest'
import { agentRuns, workspaces } from '../src/db/schema.js'
import { createDrizzleRepositories } from '../src/repositories/drizzle.js'
import { setupTestDb } from './harness.js'

// Cross-runtime parity for the platform-operator rollups against the Node facade's real
// Drizzle/Postgres store. The Cloudflare Worker runs the identical suite over D1, so the
// two dialects' GROUP BY / JSON extraction / window bounds can't drift. CI provides
// Postgres via `DATABASE_URL`.

const databaseUrl = process.env.DATABASE_URL

if (databaseUrl) {
  const db = await setupTestDb()
  const repos = createDrizzleRepositories(db, { now: () => Date.now() })
  const seed: PlatformMetricsSeed = {
    async workspace(id, accountId) {
      await db
        .insert(workspaces)
        .values({ id, name: id, created_at: 0, account_id: accountId })
        .onConflictDoNothing()
    },
    async run(row) {
      await db.insert(agentRuns).values({
        workspace_id: row.workspaceId,
        id: row.id,
        kind: row.kind,
        status: row.status,
        created_at: row.createdAt,
        updated_at: row.updatedAt,
        failure: row.failureKind ? JSON.stringify({ kind: row.failureKind, message: 'x' }) : null,
      })
    },
  }
  definePlatformMetricsSuite(
    'node',
    () => repos.platformMetricsRepository,
    () => seed,
  )
} else {
  describe.skip('[node] platform metrics (set DATABASE_URL to run)', () => {
    it('requires Postgres', () => {})
  })
}
