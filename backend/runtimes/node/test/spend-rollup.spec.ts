import { type SpendRollupSeed, defineSpendRollupSuite } from '@cat-factory/conformance'
import { inArray } from 'drizzle-orm'
import { describe, it } from 'vitest'
import {
  agentRuns,
  blocks,
  githubRepos,
  services,
  tasks,
  tokenUsage,
  workspaces,
} from '../src/db/schema.js'
import { createDrizzleRepositories } from '../src/repositories/drizzle.js'
import { setupTestDb } from './harness.js'

// Cross-runtime parity for the durable cost-attribution rollup against the Node facade's real
// Drizzle/Postgres store. The Cloudflare Worker runs the identical suite over D1, so neither
// the fold's seven joins nor the day bucketing nor the frozen labels can drift between the two
// dialects, and both are checked against the ledger reads they stand in for. CI provides
// Postgres via `DATABASE_URL`.

const databaseUrl = process.env.DATABASE_URL

if (databaseUrl) {
  const db = await setupTestDb()
  const repos = createDrizzleRepositories(db, { now: () => Date.now() })
  const seed: SpendRollupSeed = {
    async workspace(id, accountId, name) {
      await db
        .insert(workspaces)
        .values({ id, name, created_at: 0, account_id: accountId })
        .onConflictDoNothing()
    },
    async block(workspaceId, id, title, taskType) {
      await db.insert(blocks).values({
        workspace_id: workspaceId,
        id,
        title,
        type: 'feature',
        status: 'planned',
        task_type: taskType,
      })
    },
    async service(id, accountId, frameBlockId, repoGithubId) {
      await db.insert(services).values({
        id,
        account_id: accountId,
        frame_block_id: frameBlockId,
        repo_github_id: repoGithubId ?? null,
        created_at: 0,
      })
    },
    async repo(workspaceId, githubId, owner, name) {
      await db.insert(githubRepos).values({
        workspace_id: workspaceId,
        github_id: githubId,
        installation_id: 1,
        owner,
        name,
        synced_at: 0,
      })
    },
    async ticket(row) {
      await db.insert(tasks).values({
        workspace_id: row.workspaceId,
        source: row.source,
        external_id: row.externalId,
        title: row.title,
        url: '',
        linked_block_id: row.linkedBlockId,
        synced_at: 0,
      })
    },
    async run(row) {
      await db.insert(agentRuns).values({
        workspace_id: row.workspaceId,
        id: row.id,
        kind: row.kind ?? 'execution',
        status: row.status,
        created_at: row.createdAt,
        updated_at: row.updatedAt,
        service_id: row.serviceId ?? null,
        block_id: row.blockId ?? null,
      })
    },
    async usage(row) {
      await db.insert(tokenUsage).values({
        id: row.id,
        workspace_id: row.workspaceId,
        execution_id: row.executionId,
        agent_kind: row.agentKind,
        provider: row.provider,
        model: row.model,
        input_tokens: row.inputTokens,
        output_tokens: row.outputTokens,
        cost_estimate: row.costEstimate,
        billing: row.billing,
        created_at: row.createdAt,
      })
    },
    async forgetSources(workspaceIds) {
      // What retention and an ordinary board tidy-up do over time: the ledger rows, the runs a
      // live read joins through, and the imported tickets it resolves a ref from. The BOARDS
      // stay: `forgetBoards` is the other case, and the rewrite must tell them apart.
      await db.delete(tokenUsage).where(inArray(tokenUsage.workspace_id, workspaceIds))
      await db.delete(agentRuns).where(inArray(agentRuns.workspace_id, workspaceIds))
      await db.delete(tasks).where(inArray(tasks.workspace_id, workspaceIds))
    },
    async forgetBoards(workspaceIds) {
      // The workspace-delete cascade: every workspace-scoped table (`token_usage` among them)
      // and then the root row. `spend_days` is deliberately NOT in that list.
      await this.forgetSources(workspaceIds)
      await db.delete(workspaces).where(inArray(workspaces.id, workspaceIds))
    },
  }
  defineSpendRollupSuite(
    'node',
    () => ({ reports: repos.reportsRepository, rollup: repos.spendRollupRepository }),
    () => seed,
  )
} else {
  describe.skip('[node] durable spend rollup (set DATABASE_URL to run)', () => {
    it('requires Postgres', () => {})
  })
}
