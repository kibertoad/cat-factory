import type { CustomManifestTypeRecord, CustomManifestTypeRepository } from '@cat-factory/kernel'
import { and, asc, eq } from 'drizzle-orm'
import type { DrizzleDb } from '../db/client.js'
import { customManifestTypes } from '../db/schema.js'

// Postgres mirror of D1CustomManifestTypeRepository (migration 0024): workspace-defined
// custom-manifest-type catalog entries, keyed by (workspace_id, manifest_id).

type Row = typeof customManifestTypes.$inferSelect

function toRecord(row: Row): CustomManifestTypeRecord {
  return {
    workspaceId: row.workspace_id,
    manifestId: row.manifest_id,
    label: row.label,
    acceptsInputHint: row.accepts_input_hint,
    description: row.description,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

export class DrizzleCustomManifestTypeRepository implements CustomManifestTypeRepository {
  constructor(private readonly db: DrizzleDb) {}

  async listByWorkspace(workspaceId: string): Promise<CustomManifestTypeRecord[]> {
    const rows = await this.db
      .select()
      .from(customManifestTypes)
      .where(eq(customManifestTypes.workspace_id, workspaceId))
      .orderBy(asc(customManifestTypes.created_at))
    return rows.map(toRecord)
  }

  async upsert(record: CustomManifestTypeRecord): Promise<void> {
    await this.db
      .insert(customManifestTypes)
      .values({
        workspace_id: record.workspaceId,
        manifest_id: record.manifestId,
        label: record.label,
        accepts_input_hint: record.acceptsInputHint,
        description: record.description,
        created_at: record.createdAt,
        updated_at: record.updatedAt,
      })
      .onConflictDoUpdate({
        target: [customManifestTypes.workspace_id, customManifestTypes.manifest_id],
        set: {
          label: record.label,
          accepts_input_hint: record.acceptsInputHint,
          description: record.description,
          updated_at: record.updatedAt,
        },
      })
  }

  async remove(workspaceId: string, manifestId: string): Promise<void> {
    await this.db
      .delete(customManifestTypes)
      .where(
        and(
          eq(customManifestTypes.workspace_id, workspaceId),
          eq(customManifestTypes.manifest_id, manifestId),
        ),
      )
  }
}
