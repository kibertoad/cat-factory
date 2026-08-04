import { type PlatformMetricsSeed, definePlatformMetricsSuite } from '@cat-factory/conformance'
import { env } from 'cloudflare:test'
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
      `INSERT INTO agent_runs (workspace_id, id, kind, status, detail, created_at, updated_at, failure)
       VALUES (?, ?, ?, ?, '{}', ?, ?, ?)
       ON CONFLICT(workspace_id, id) DO UPDATE SET
         status = excluded.status, updated_at = excluded.updated_at, failure = excluded.failure`,
    )
      .bind(
        row.workspaceId,
        row.id,
        row.kind,
        row.status,
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
