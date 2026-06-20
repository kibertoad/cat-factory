import type { BlockPatch, BlockRepository } from '@cat-factory/kernel'
import type { Block } from '@cat-factory/contracts'
import type { D1Database } from '@cloudflare/workers-types'
import { type BlockRow, blockInsertValues, blockPatchToColumns, rowToBlock } from './mappers'

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
    return results.map(rowToBlock)
  }

  async listByService(serviceId: string): Promise<Block[]> {
    const { results } = await this.db
      .prepare('SELECT * FROM blocks WHERE service_id = ? ORDER BY rowid')
      .bind(serviceId)
      .all<BlockRow>()
    return results.map(rowToBlock)
  }

  async get(workspaceId: string, id: string): Promise<Block | null> {
    const row = await this.db
      .prepare('SELECT * FROM blocks WHERE workspace_id = ? AND id = ?')
      .bind(workspaceId, id)
      .first<BlockRow>()
    return row ? rowToBlock(row) : null
  }

  async serviceIdOf(workspaceId: string, blockId: string): Promise<string | null> {
    const row = await this.db
      .prepare('SELECT service_id FROM blocks WHERE workspace_id = ? AND id = ?')
      .bind(workspaceId, blockId)
      .first<{ service_id: string | null }>()
    return row?.service_id ?? null
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
