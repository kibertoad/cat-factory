import type { AgentFailure, Clock, ExecutionRepository, RunRef } from '@cat-factory/kernel'
import type { ExecutionInstance } from '@cat-factory/contracts'
import type { D1Database } from '@cloudflare/workers-types'
import { chunkForIn } from './chunk'
import { type ExecutionRow, rowToExecution } from './mappers'

/**
 * Execution runs, stored as `kind='execution'` rows of the unified `agent_runs`
 * table (migration 0019). Every statement is scoped by `kind='execution'` so the
 * bootstrap flow's rows (owned by {@link D1BootstrapJobRepository}) never collide
 * — in particular `deleteByBlock` must NOT delete the bootstrap run that created a
 * service frame when an execution on that block is replaced/cancelled.
 */
export class D1ExecutionRepository implements ExecutionRepository {
  private readonly db: D1Database
  private readonly clock: Clock

  constructor({ db, clock }: { db: D1Database; clock: Clock }) {
    this.db = db
    this.clock = clock
  }

  async listByWorkspace(workspaceId: string): Promise<ExecutionInstance[]> {
    const { results } = await this.db
      .prepare(
        `SELECT * FROM agent_runs WHERE workspace_id = ? AND kind = 'execution' ORDER BY created_at`,
      )
      .bind(workspaceId)
      .all<ExecutionRow>()
    return results.map(rowToExecution)
  }

  async listByService(serviceId: string): Promise<ExecutionInstance[]> {
    const { results } = await this.db
      .prepare(
        `SELECT * FROM agent_runs WHERE service_id = ? AND kind = 'execution' ORDER BY created_at`,
      )
      .bind(serviceId)
      .all<ExecutionRow>()
    return results.map(rowToExecution)
  }

  async listByServices(serviceIds: string[]): Promise<ExecutionInstance[]> {
    if (serviceIds.length === 0) return []
    const out: ExecutionInstance[] = []
    // Chunk the IN list to stay under D1's bound-parameter limit.
    for (const chunk of chunkForIn(serviceIds)) {
      const placeholders = chunk.map(() => '?').join(', ')
      const { results } = await this.db
        .prepare(
          `SELECT * FROM agent_runs WHERE service_id IN (${placeholders}) AND kind = 'execution' ORDER BY created_at`,
        )
        .bind(...chunk)
        .all<ExecutionRow>()
      for (const row of results) out.push(rowToExecution(row))
    }
    return out
  }

  async get(workspaceId: string, id: string): Promise<ExecutionInstance | null> {
    const row = await this.db
      .prepare(`SELECT * FROM agent_runs WHERE workspace_id = ? AND id = ? AND kind = 'execution'`)
      .bind(workspaceId, id)
      .first<ExecutionRow>()
    return row ? rowToExecution(row) : null
  }

  async getByBlock(workspaceId: string, blockId: string): Promise<ExecutionInstance | null> {
    const row = await this.db
      .prepare(
        `SELECT * FROM agent_runs WHERE workspace_id = ? AND block_id = ? AND kind = 'execution'`,
      )
      .bind(workspaceId, blockId)
      .first<ExecutionRow>()
    return row ? rowToExecution(row) : null
  }

  async upsert(workspaceId: string, execution: ExecutionInstance): Promise<void> {
    // The pipeline shape lives in `detail`; lifecycle is top-level. `updated_at`
    // is refreshed on every write so it doubles as the sweeper's lease.
    // `error`/`failure`/`workflow_instance_id` are deliberately left out of the
    // conflict update so they survive normal step writes (see markFailed).
    const now = this.clock.now()
    const detail = JSON.stringify({
      pipelineId: execution.pipelineId,
      pipelineName: execution.pipelineName,
      steps: execution.steps,
      currentStep: execution.currentStep,
    })
    // Stamp `service_id` from the run's block so the run is discoverable by service (in-org
    // sharing): a shared service's runs surface on every board that mounts it via
    // `listByService`. Derived here (not carried on ExecutionInstance) and refreshed on every
    // write so it follows a reparent that re-homes the block to another service.
    await this.db
      .prepare(
        `INSERT INTO agent_runs
           (workspace_id, id, kind, block_id, status, detail, created_at, updated_at,
            workflow_instance_id, service_id)
         VALUES (?, ?, 'execution', ?, ?, ?, ?, ?, ?,
            (SELECT service_id FROM blocks WHERE workspace_id = ? AND id = ?))
         ON CONFLICT (workspace_id, id) DO UPDATE SET
           block_id = excluded.block_id,
           status = excluded.status,
           detail = excluded.detail,
           updated_at = excluded.updated_at,
           service_id = excluded.service_id`,
      )
      .bind(
        workspaceId,
        execution.id,
        execution.blockId,
        execution.status,
        detail,
        now,
        now,
        // Instance id == execution id today; stored for forward-compatibility.
        execution.id,
        workspaceId,
        execution.blockId,
      )
      .run()
  }

  async deleteByBlock(workspaceId: string, blockId: string): Promise<void> {
    await this.db
      .prepare(
        `DELETE FROM agent_runs WHERE workspace_id = ? AND block_id = ? AND kind = 'execution'`,
      )
      .bind(workspaceId, blockId)
      .run()
  }

  async listStale(olderThanEpochMs: number): Promise<RunRef[]> {
    const { results } = await this.db
      .prepare(
        `SELECT workspace_id, id FROM agent_runs
         WHERE kind = 'execution' AND status = 'running' AND updated_at < ?
         ORDER BY updated_at`,
      )
      .bind(olderThanEpochMs)
      .all<{ workspace_id: string; id: string }>()
    return results.map((r) => ({ workspaceId: r.workspace_id, id: r.id }))
  }

  async markFailed(workspaceId: string, id: string, failure: AgentFailure): Promise<void> {
    await this.db
      .prepare(
        `UPDATE agent_runs
           SET status = 'failed', error = ?, failure = ?, updated_at = ?
         WHERE workspace_id = ? AND id = ? AND kind = 'execution'`,
      )
      .bind(failure.message, JSON.stringify(failure), this.clock.now(), workspaceId, id)
      .run()
  }
}
