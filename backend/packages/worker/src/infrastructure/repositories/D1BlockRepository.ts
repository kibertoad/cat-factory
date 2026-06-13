import type { BlockPatch, BlockRepository } from '@cat-factory/core'
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

  async get(workspaceId: string, id: string): Promise<Block | null> {
    const row = await this.db
      .prepare('SELECT * FROM blocks WHERE workspace_id = ? AND id = ?')
      .bind(workspaceId, id)
      .first<BlockRow>()
    return row ? rowToBlock(row) : null
  }

  async insert(workspaceId: string, block: Block): Promise<void> {
    const values = { workspace_id: workspaceId, ...blockInsertValues(block) }
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

  async deleteMany(workspaceId: string, ids: string[]): Promise<void> {
    if (ids.length === 0) return
    const placeholders = ids.map(() => '?').join(', ')
    await this.db
      .prepare(`DELETE FROM blocks WHERE workspace_id = ? AND id IN (${placeholders})`)
      .bind(workspaceId, ...ids)
      .run()
  }
}
