import type { BlockPatch, BlockRepository } from '@cat-factory/kernel'
import type { Block } from '@cat-factory/contracts'
import { tryDecodeRows } from '@cat-factory/server'
import type { D1Database } from '@cloudflare/workers-types'
import { chunkForIn } from './chunk'
import { type BlockRow, blockInsertValues, blockPatchToColumns, rowToBlock } from './mappers'

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
    const columns = Object.keys(set)
    if (columns.length === 0) return
    const assignments = columns.map((c) => `${c} = ?`).join(', ')
    await this.db
      .prepare(`UPDATE blocks SET ${assignments} WHERE workspace_id = ? AND id = ?`)
      .bind(...Object.values(set), workspaceId, id)
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

  async deleteMany(workspaceId: string, ids: string[]): Promise<void> {
    if (ids.length === 0) return
    const placeholders = ids.map(() => '?').join(', ')
    await this.db
      .prepare(`DELETE FROM blocks WHERE workspace_id = ? AND id IN (${placeholders})`)
      .bind(workspaceId, ...ids)
      .run()
  }
}
