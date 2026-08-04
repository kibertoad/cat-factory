import { type ReportsSeed, defineReportsSuite } from '@cat-factory/conformance'
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

// Cross-runtime parity for the usage-analytics rollups against the Node facade's real
// Drizzle/Postgres store. The Cloudflare Worker runs the identical suite over D1, so the
// two dialects' GROUP BY / joins / window bounds / cost split can't drift. CI provides
// Postgres via `DATABASE_URL`.

const databaseUrl = process.env.DATABASE_URL

if (databaseUrl) {
  const db = await setupTestDb()
  const repos = createDrizzleRepositories(db, { now: () => Date.now() })
  const seed: ReportsSeed = {
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
  }
  defineReportsSuite(
    'node',
    () => repos.reportsRepository,
    () => seed,
  )
} else {
  describe.skip('[node] reports (set DATABASE_URL to run)', () => {
    it('requires Postgres', () => {})
  })
}
