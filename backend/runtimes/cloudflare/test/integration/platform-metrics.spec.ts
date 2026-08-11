import {
  type PlatformMetricsSeed,
  definePlatformMetricsSuite,
  defineUndecodableRunSuite,
} from '@cat-factory/conformance'
import { env } from 'cloudflare:test'
import { D1AgentRunRepository } from '../../src/infrastructure/repositories/D1AgentRunRepository'
import { D1ExecutionRepository } from '../../src/infrastructure/repositories/D1ExecutionRepository'
import { D1PlatformMetricsRepository } from '../../src/infrastructure/repositories/D1PlatformMetricsRepository'

// Cross-runtime parity for the platform-operator rollups against the Worker's real D1
// store inside workerd. The Node service runs the identical suite over Postgres, so the
// two dialects' GROUP BY / JSON extraction / window bounds can't drift.

const seed: PlatformMetricsSeed = {
  async workspace(id, accountId) {
    await env.DB.prepare(
      'INSERT OR IGNORE INTO workspaces (id, name, created_at, account_id) VALUES (?, ?, ?, ?)',
    )
      .bind(id, id, 0, accountId)
      .run()
  },
  async run(row) {
    await env.DB.prepare(
      // Upsert on the run's real primary key, so re-seeding an id MOVES that run's status the
      // way the engine does instead of failing on the conflict (see `PlatformMetricsSeed.run`).
      `INSERT INTO agent_runs (workspace_id, id, kind, status, block_id, detail, created_at, updated_at, failure)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(workspace_id, id) DO UPDATE SET
         status = excluded.status, updated_at = excluded.updated_at, failure = excluded.failure`,
    )
      .bind(
        row.workspaceId,
        row.id,
        row.kind,
        row.status,
        row.blockId ?? null,
        row.detail ?? '{}',
        row.createdAt,
        row.updatedAt,
        row.failureKind ? JSON.stringify({ kind: row.failureKind, message: 'x' }) : null,
      )
      .run()
  },
}

definePlatformMetricsSuite(
  'cloudflare',
  () => new D1PlatformMetricsRepository({ db: env.DB }),
  () => seed,
)

// Shares the raw seed above: the poison row it needs is one no domain write path may produce.
defineUndecodableRunSuite('cloudflare', () => ({
  executions: new D1ExecutionRepository({ db: env.DB, clock: { now: () => Date.now() } }),
  agentRuns: new D1AgentRunRepository({ db: env.DB }),
  platformMetrics: new D1PlatformMetricsRepository({ db: env.DB }),
  seed,
}))
