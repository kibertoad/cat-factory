import { type SpendRollupSeed, defineSpendRollupSuite } from '@cat-factory/conformance'
import { env } from 'cloudflare:test'
import { D1ReportsRepository } from '../../src/infrastructure/repositories/D1ReportsRepository'
import { D1SpendRollupRepository } from '../../src/infrastructure/repositories/D1SpendRollupRepository'

// Cross-runtime parity for the durable cost-attribution rollup against the Worker's real D1
// store inside workerd. The Node service runs the identical suite over Postgres, so neither
// the fold's seven joins nor the day bucketing nor the frozen labels can drift between the two
// dialects, and both are checked against the ledger reads they stand in for.

function placeholders(count: number): string {
  return Array.from({ length: count }, () => '?').join(', ')
}

const seed: SpendRollupSeed = {
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
  async forgetSources(workspaceIds) {
    // What retention and an ordinary board tidy-up do over time: the ledger rows, the runs a
    // live read joins through, and the imported tickets it resolves a ref from. The BOARDS
    // stay: `forgetBoards` is the other case, and the rewrite must tell them apart.
    const marks = placeholders(workspaceIds.length)
    await env.DB.batch([
      env.DB.prepare(`DELETE FROM token_usage WHERE workspace_id IN (${marks})`).bind(
        ...workspaceIds,
      ),
      env.DB.prepare(`DELETE FROM agent_runs WHERE workspace_id IN (${marks})`).bind(
        ...workspaceIds,
      ),
      env.DB.prepare(`DELETE FROM tasks WHERE workspace_id IN (${marks})`).bind(...workspaceIds),
    ])
  },
  async forgetBoards(workspaceIds) {
    // The workspace-delete cascade: every workspace-scoped table (`token_usage` among them)
    // and then the root row. `spend_days` is deliberately NOT in that list.
    await this.forgetSources(workspaceIds)
    const marks = placeholders(workspaceIds.length)
    await env.DB.prepare(`DELETE FROM workspaces WHERE id IN (${marks})`)
      .bind(...workspaceIds)
      .run()
  },
}

defineSpendRollupSuite(
  'cloudflare',
  () => ({
    reports: new D1ReportsRepository({ db: env.DB }),
    rollup: new D1SpendRollupRepository({ db: env.DB }),
  }),
  () => seed,
)
