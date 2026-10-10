import { type ReportsSeed, defineReportsSuite } from '@cat-factory/conformance'
import { env } from 'cloudflare:test'
import { D1ReportsRepository } from '../../src/infrastructure/repositories/D1ReportsRepository'

// Cross-runtime parity for the usage-analytics rollups against the Worker's real D1 store
// inside workerd. The Node service runs the identical suite over Postgres, so the two
// dialects' GROUP BY / joins / window bounds / cost split can't drift.

const seed: ReportsSeed = {
  async workspace(id, accountId, name) {
    await env.DB.prepare(
      'INSERT OR IGNORE INTO workspaces (id, name, created_at, account_id) VALUES (?, ?, ?, ?)',
    )
      .bind(id, name, 0, accountId)
      .run()
  },
  async block(workspaceId, id, title, taskType) {
    await env.DB.prepare(
      `INSERT INTO blocks (workspace_id, id, title, type, status, task_type)
       VALUES (?, ?, ?, 'feature', 'planned', ?)`,
    )
      .bind(workspaceId, id, title, taskType)
      .run()
  },
  async service(id, accountId, frameBlockId, repoGithubId) {
    await env.DB.prepare(
      `INSERT INTO services (id, account_id, frame_block_id, repo_github_id, created_at)
       VALUES (?, ?, ?, ?, 0)`,
    )
      .bind(id, accountId, frameBlockId, repoGithubId ?? null)
      .run()
  },
  async repo(workspaceId, githubId, owner, name) {
    await env.DB.prepare(
      `INSERT INTO github_repos (workspace_id, github_id, installation_id, owner, name, synced_at)
       VALUES (?, ?, 1, ?, ?, 0)`,
    )
      .bind(workspaceId, githubId, owner, name)
      .run()
  },
  async ticket(row) {
    await env.DB.prepare(
      `INSERT INTO tasks (workspace_id, source, external_id, title, url, linked_block_id, synced_at)
       VALUES (?, ?, ?, ?, '', ?, 0)`,
    )
      .bind(row.workspaceId, row.source, row.externalId, row.title, row.linkedBlockId)
      .run()
  },
  async run(row) {
    await env.DB.prepare(
      `INSERT INTO agent_runs
         (workspace_id, id, kind, status, detail, created_at, updated_at, service_id, block_id)
       VALUES (?, ?, ?, ?, '{}', ?, ?, ?, ?)`,
    )
      .bind(
        row.workspaceId,
        row.id,
        row.kind ?? 'execution',
        row.status,
        row.createdAt,
        row.updatedAt,
        row.serviceId ?? null,
        row.blockId ?? null,
      )
      .run()
  },
  async usage(row) {
    await env.DB.prepare(
      `INSERT INTO token_usage
         (id, workspace_id, execution_id, agent_kind, provider, model,
          input_tokens, output_tokens, cost_estimate, billing, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(
        row.id,
        row.workspaceId,
        row.executionId,
        row.agentKind,
        row.provider,
        row.model,
        row.inputTokens,
        row.outputTokens,
        row.costEstimate,
        row.billing,
        row.createdAt,
      )
      .run()
  },
}

defineReportsSuite(
  'cloudflare',
  () => new D1ReportsRepository({ db: env.DB }),
  () => seed,
)
