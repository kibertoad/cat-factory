import {
  type PlatformMetricsSeed,
  definePlatformMetricsSuite,
  defineUndecodableRunSuite,
} from '@cat-factory/conformance'
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
      const failure = row.failureKind
        ? JSON.stringify({ kind: row.failureKind, message: 'x' })
        : null
      // Upsert on the run's real primary key, so re-seeding an id MOVES that run's status the
      // way the engine does instead of failing on the conflict (see `PlatformMetricsSeed.run`).
      await db
        .insert(agentRuns)
        .values({
          workspace_id: row.workspaceId,
          id: row.id,
          kind: row.kind,
          status: row.status,
          block_id: row.blockId ?? null,
          detail: row.detail ?? '{}',
          created_at: row.createdAt,
          updated_at: row.updatedAt,
          failure,
        })
        .onConflictDoUpdate({
          target: [agentRuns.workspace_id, agentRuns.id],
          set: { status: row.status, updated_at: row.updatedAt, failure },
        })
    },
  }
  definePlatformMetricsSuite(
    'node',
    () => repos.platformMetricsRepository,
    () => seed,
  )
  // Shares the raw seed above: the poison row it needs is one no domain write path may produce.
  defineUndecodableRunSuite('node', () => ({
    executions: repos.executionRepository,
    agentRuns: repos.agentRunRepository,
    platformMetrics: repos.platformMetricsRepository,
    seed,
  }))
} else {
  describe.skip('[node] platform metrics (set DATABASE_URL to run)', () => {
    it('requires Postgres', () => {})
  })
}
