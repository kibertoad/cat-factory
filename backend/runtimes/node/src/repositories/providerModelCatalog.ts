import type {
  ProviderModelCatalogRecord,
  ProviderModelCatalogRepository,
} from '@cat-factory/kernel'
import type { OpenRouterModelMeta } from '@cat-factory/contracts'
import { and, asc, eq } from 'drizzle-orm'
import type { DrizzleDb } from '../db/client.js'
import { providerModelCatalog } from '../db/schema.js'

// Postgres-backed store for a workspace's enabled gateway models (mirror of D1 migration
// 0006 / D1ProviderModelCatalogRepository), keyed by (workspace_id, provider).

type Row = typeof providerModelCatalog.$inferSelect

function toRecord(row: Row): ProviderModelCatalogRecord {
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

export class DrizzleProviderModelCatalogRepository implements ProviderModelCatalogRepository {
  constructor(private readonly db: DrizzleDb) {}

  async getByWorkspace(
    workspaceId: string,
    provider: string,
  ): Promise<ProviderModelCatalogRecord | null> {
    const rows = await this.db
      .select()
      .from(providerModelCatalog)
      .where(
        and(
          eq(providerModelCatalog.workspace_id, workspaceId),
          eq(providerModelCatalog.provider, provider),
        ),
      )
      .limit(1)
    return rows[0] ? toRecord(rows[0]) : null
  }

  async listByWorkspace(workspaceId: string): Promise<ProviderModelCatalogRecord[]> {
    const rows = await this.db
      .select()
      .from(providerModelCatalog)
      .where(eq(providerModelCatalog.workspace_id, workspaceId))
      .orderBy(asc(providerModelCatalog.provider))
    return rows.map(toRecord)
  }

  async upsert(record: ProviderModelCatalogRecord): Promise<void> {
    await this.db
      .insert(providerModelCatalog)
      .values({
        workspace_id: record.workspaceId,
        provider: record.provider,
        models: JSON.stringify(record.models),
        created_at: record.createdAt,
        updated_at: record.updatedAt,
      })
      .onConflictDoUpdate({
        target: [providerModelCatalog.workspace_id, providerModelCatalog.provider],
        set: {
          models: JSON.stringify(record.models),
          updated_at: record.updatedAt,
        },
      })
  }

  async remove(workspaceId: string, provider: string): Promise<void> {
    await this.db
      .delete(providerModelCatalog)
      .where(
        and(
          eq(providerModelCatalog.workspace_id, workspaceId),
          eq(providerModelCatalog.provider, provider),
        ),
      )
  }
}
