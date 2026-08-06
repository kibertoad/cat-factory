import type { BlockPatch, BlockRepository } from '@cat-factory/kernel'
import type { Block, BlockStatus } from '@cat-factory/contracts'
import { tryDecodeRows } from '@cat-factory/server'
import type { D1Database } from '@cloudflare/workers-types'
import { chunkForIn } from './chunk'
import {
  type BlockRow,
  blockCompletionStamp,
  blockInsertValues,
  blockPatchToColumns,
  rowToBlock,
} from './mappers'

const blockContext = (row: BlockRow) => ({ table: 'blocks', id: row.id })

export class D1BlockRepository implements BlockRepository {
  private readonly db: D1Database

  constructor({ db }: { db: D1Database }) {
    this.db = db
  }

  async listByWorkspace(workspaceId: string): Promise<Block[]> {
    const { results } = await this.db
      .prepare('SELECT * FROM blocks WHERE workspace_id = ? ORDER BY rowid')
      .bind(workspaceId)
      .all<BlockRow>()
    // Snapshot-facing list read: drop a corrupt block rather than failing the whole board load.
    return tryDecodeRows(results, rowToBlock, blockContext)
  }

  async listByService(serviceId: string): Promise<Block[]> {
    const { results } = await this.db
      .prepare('SELECT * FROM blocks WHERE service_id = ? ORDER BY rowid')
      .bind(serviceId)
      .all<BlockRow>()
    return tryDecodeRows(results, rowToBlock, blockContext)
  }

  async listByServices(serviceIds: string[]): Promise<Block[]> {
    if (serviceIds.length === 0) return []
    const out: Block[] = []
    // Chunk the IN list to stay under D1's bound-parameter limit.
    for (const chunk of chunkForIn(serviceIds)) {
      const placeholders = chunk.map(() => '?').join(', ')
      const { results } = await this.db
        .prepare(`SELECT * FROM blocks WHERE service_id IN (${placeholders}) ORDER BY rowid`)
        .bind(...chunk)
        .all<BlockRow>()
      out.push(...tryDecodeRows(results, rowToBlock, blockContext))
    }
    return out
  }

  async get(workspaceId: string, id: string): Promise<Block | null> {
    const row = await this.db
      .prepare('SELECT * FROM blocks WHERE workspace_id = ? AND id = ?')
      .bind(workspaceId, id)
      .first<BlockRow>()
    return row ? rowToBlock(row) : null
  }

  async findById(
    blockId: string,
  ): Promise<{ workspaceId: string; serviceId: string | null; block: Block } | null> {
    const row = await this.db
      .prepare('SELECT * FROM blocks WHERE id = ? LIMIT 1')
      .bind(blockId)
      .first<BlockRow & { workspace_id: string; service_id: string | null }>()
    if (!row) return null
    return {
      workspaceId: row.workspace_id,
      serviceId: row.service_id ?? null,
      block: rowToBlock(row),
    }
  }

  async findByIds(
    blockIds: string[],
  ): Promise<Array<{ workspaceId: string; serviceId: string | null; block: Block }>> {
    if (blockIds.length === 0) return []
    const out: Array<{ workspaceId: string; serviceId: string | null; block: Block }> = []
    // Chunk the IN list to stay under D1's bound-parameter limit.
    for (const chunk of chunkForIn(blockIds)) {
      const placeholders = chunk.map(() => '?').join(', ')
      const { results } = await this.db
        .prepare(`SELECT * FROM blocks WHERE id IN (${placeholders})`)
        .bind(...chunk)
        .all<BlockRow & { workspace_id: string; service_id: string | null }>()
      for (const row of results ?? []) {
        out.push({
          workspaceId: row.workspace_id,
          serviceId: row.service_id ?? null,
          block: rowToBlock(row),
        })
      }
    }
    return out
  }

  async insert(workspaceId: string, block: Block, serviceId?: string | null): Promise<void> {
    const values = {
      workspace_id: workspaceId,
      service_id: serviceId ?? null,
      ...blockInsertValues(block),
    }
    const columns = Object.keys(values)
    const placeholders = columns.map(() => '?').join(', ')
    await this.db
      .prepare(`INSERT INTO blocks (${columns.join(', ')}) VALUES (${placeholders})`)
      .bind(...Object.values(values))
      .run()
  }

  async update(workspaceId: string, id: string, patch: BlockPatch): Promise<void> {
    const set = blockPatchToColumns(patch)
    const assignments = Object.keys(set).map((c) => `${c} = ?`)
    const binds = Object.values(set)

    // `completed_at` is derived here rather than at the call sites that mark a task done
    // (see `blockCompletionStamp`). `COALESCE` is what makes the stamp first-write-wins
    // against a replaying durable driver: SQLite evaluates the right-hand side against the
    // row's PRE-update value, so a second `done` write keeps the original date.
    const stamp = blockCompletionStamp(patch, Date.now())
    if (stamp.kind === 'stampIfUnset') {
      assignments.push(`completed_at = COALESCE(completed_at, ?)`)
      binds.push(stamp.at)
    } else if (stamp.kind === 'clear') {
      assignments.push(`completed_at = NULL`)
    }

    if (assignments.length === 0) return
    await this.db
      .prepare(`UPDATE blocks SET ${assignments.join(', ')} WHERE workspace_id = ? AND id = ?`)
      .bind(...binds, workspaceId, id)
      .run()
  }

  async setService(workspaceId: string, ids: string[], serviceId: string | null): Promise<void> {
    if (ids.length === 0) return
    const placeholders = ids.map(() => '?').join(', ')
    await this.db
      .prepare(
        `UPDATE blocks SET service_id = ? WHERE workspace_id = ? AND id IN (${placeholders})`,
      )
      .bind(serviceId, workspaceId, ...ids)
      .run()
  }

  async shiftChildPositions(
    workspaceId: string,
    parentId: string,
    dx: number,
    dy: number,
  ): Promise<void> {
    if (dx === 0 && dy === 0) return
    await this.db
      .prepare(
        'UPDATE blocks SET pos_x = pos_x + ?, pos_y = pos_y + ? WHERE workspace_id = ? AND parent_id = ?',
      )
      .bind(dx, dy, workspaceId, parentId)
      .run()
  }

  async deleteMany(workspaceId: string, ids: string[]): Promise<void> {
    if (ids.length === 0) return
    const placeholders = ids.map(() => '?').join(', ')
    await this.db
      .prepare(`DELETE FROM blocks WHERE workspace_id = ? AND id IN (${placeholders})`)
      .bind(workspaceId, ...ids)
      .run()
  }

  async countActiveInternal(workspaceId: string): Promise<number> {
    const row = await this.db
      .prepare(
        "SELECT COUNT(*) AS n FROM blocks WHERE workspace_id = ? AND internal = 1 AND status = 'in_progress'",
      )
      .bind(workspaceId)
      .first<{ n: number }>()
    return row?.n ?? 0
  }

  async listServiceTasks(
    workspaceId: string,
    frameId: string,
    opts: { limit: number; afterId?: string; status?: BlockStatus },
  ): Promise<Block[]> {
    // A `task` may only hang off a `frame` or a `module`, so "parented by the frame, or by a
    // module of the frame" covers the whole task subtree — no recursion needed. The module leg is
    // a SUBQUERY, not an id list bound from a prior read: D1 rejects any statement with more than
    // 100 bound parameters, so an `IN (...)` over the modules would hard-fail on a service that
    // accumulated ~96 of them. Both legs ride idx_blocks_parent (workspace_id, parent_id).
    const where = [
      `workspace_id = ?`,
      `(parent_id = ? OR parent_id IN (
          SELECT id FROM blocks WHERE workspace_id = ? AND parent_id = ? AND level = 'module'))`,
      `level = 'task'`,
      // `internal` is a nullable flag: an ordinary block stores NULL, an anchor stores 1.
      `(internal IS NULL OR internal = 0)`,
    ]
    const binds: (string | number)[] = [workspaceId, frameId, workspaceId, frameId]
    if (opts.status) {
      where.push('status = ?')
      binds.push(opts.status)
    }
    if (opts.afterId) {
      where.push('id > ?')
      binds.push(opts.afterId)
    }
    const { results } = await this.db
      .prepare(`SELECT * FROM blocks WHERE ${where.join(' AND ')} ORDER BY id LIMIT ?`)
      .bind(...binds, opts.limit)
      .all<BlockRow>()
    return tryDecodeRows(results, rowToBlock, blockContext)
  }
}
