import type {
  ProviderModelCatalogRecord,
  ProviderModelCatalogRepository,
} from '@cat-factory/kernel'
import type { OpenRouterModelMeta } from '@cat-factory/contracts'
import type { D1Database } from '@cloudflare/workers-types'

interface ProviderModelCatalogRow {
  workspace_id: string
  provider: string
  models: string
  created_at: number
  updated_at: number
}

function toRecord(row: ProviderModelCatalogRow): ProviderModelCatalogRecord {
  return {
    workspaceId: row.workspace_id,
    provider: row.provider,
    models: parseModels(row.models),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function parseModels(json: string): OpenRouterModelMeta[] {
  try {
    const parsed = JSON.parse(json)
    return Array.isArray(parsed) ? (parsed as OpenRouterModelMeta[]) : []
  } catch {
    return []
  }
}

/** D1-backed store of a workspace's enabled gateway models (migration 0006). */
export class D1ProviderModelCatalogRepository implements ProviderModelCatalogRepository {
  private readonly db: D1Database
  constructor({ db }: { db: D1Database }) {
    this.db = db
  }

  async getByWorkspace(
    workspaceId: string,
    provider: string,
  ): Promise<ProviderModelCatalogRecord | null> {
    const row = await this.db
      .prepare(`SELECT * FROM provider_model_catalog WHERE workspace_id = ? AND provider = ?`)
      .bind(workspaceId, provider)
      .first<ProviderModelCatalogRow>()
    return row ? toRecord(row) : null
  }

  async listByWorkspace(workspaceId: string): Promise<ProviderModelCatalogRecord[]> {
    const { results } = await this.db
      .prepare(`SELECT * FROM provider_model_catalog WHERE workspace_id = ? ORDER BY provider ASC`)
      .bind(workspaceId)
      .all<ProviderModelCatalogRow>()
    return (results ?? []).map(toRecord)
  }

  async upsert(record: ProviderModelCatalogRecord): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO provider_model_catalog (workspace_id, provider, models, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (workspace_id, provider) DO UPDATE SET
           models = excluded.models,
           updated_at = excluded.updated_at`,
      )
      .bind(
        record.workspaceId,
        record.provider,
        JSON.stringify(record.models),
        record.createdAt,
        record.updatedAt,
      )
      .run()
  }

  async remove(workspaceId: string, provider: string): Promise<void> {
    await this.db
      .prepare(`DELETE FROM provider_model_catalog WHERE workspace_id = ? AND provider = ?`)
      .bind(workspaceId, provider)
      .run()
  }
}
