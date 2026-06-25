import type {
  SecretCipher,
  TaskComment,
  TaskConnectionRecord,
  TaskConnectionRepository,
  TaskRecord,
  TaskRepository,
  TaskSourceKind,
  TaskSourceSettingsRecord,
  TaskSourceSettingsRepository,
} from '@cat-factory/kernel'
import { and, desc, eq, isNull } from 'drizzle-orm'
import type { DrizzleDb } from '../db/client.js'
import { taskConnections, taskSourceSettings, tasks } from '../db/schema.js'

// Drizzle/Postgres implementations of the task-source ports, mirroring the
// Cloudflare facade's `D1TaskConnectionRepository` / `D1TaskRepository` (D1
// migration 0014) so the Jira integration behaves identically across runtimes.
// Source credentials are third-party secrets, encrypted at rest with the same
// AES-256-GCM envelope the Cloudflare store uses (never written in plaintext).

function parseCredentials(json: string): Record<string, string> {
  try {
    const parsed = JSON.parse(json)
    if (parsed && typeof parsed === 'object') return parsed as Record<string, string>
  } catch {
    // A malformed bag is treated as empty; the import path then fails closed.
  }
  return {}
}

function parseJsonArray<T>(json: string): T[] {
  try {
    const parsed = JSON.parse(json)
    if (Array.isArray(parsed)) return parsed as T[]
  } catch {
    // A malformed blob is treated as empty.
  }
  return []
}

export class DrizzleTaskConnectionRepository implements TaskConnectionRepository {
  constructor(
    private readonly db: DrizzleDb,
    private readonly cipher: SecretCipher,
  ) {}

  /** Decode the stored credential blob, decrypting the envelope when present. */
  private async decodeCredentials(stored: string): Promise<Record<string, string>> {
    if (!stored.startsWith('v1.')) return parseCredentials(stored)
    try {
      return parseCredentials(await this.cipher.decrypt(stored))
    } catch {
      return {}
    }
  }

  private async rowToRecord(
    row: typeof taskConnections.$inferSelect,
  ): Promise<TaskConnectionRecord> {
    return {
      workspaceId: row.workspace_id,
      source: row.source as TaskSourceKind,
      credentials: await this.decodeCredentials(row.credentials),
      label: row.label,
      createdAt: row.created_at,
      deletedAt: row.deleted_at,
    }
  }

  async getByWorkspace(
    workspaceId: string,
    source: TaskSourceKind,
  ): Promise<TaskConnectionRecord | null> {
    const [row] = await this.db
      .select()
      .from(taskConnections)
      .where(
        and(
          eq(taskConnections.workspace_id, workspaceId),
          eq(taskConnections.source, source),
          isNull(taskConnections.deleted_at),
        ),
      )
    return row ? this.rowToRecord(row) : null
  }

  async listByWorkspace(workspaceId: string): Promise<TaskConnectionRecord[]> {
    const rows = await this.db
      .select()
      .from(taskConnections)
      .where(and(eq(taskConnections.workspace_id, workspaceId), isNull(taskConnections.deleted_at)))
      .orderBy(desc(taskConnections.created_at))
    return Promise.all(rows.map((row) => this.rowToRecord(row)))
  }

  async upsert(record: TaskConnectionRecord): Promise<void> {
    const credentials = await this.cipher.encrypt(JSON.stringify(record.credentials))
    // A workspace has a single live connection per source: clear any prior binding
    // (live or tombstoned) before inserting, so reconnecting can't collide on the PK.
    await this.db.transaction(async (tx) => {
      await tx
        .delete(taskConnections)
        .where(
          and(
            eq(taskConnections.workspace_id, record.workspaceId),
            eq(taskConnections.source, record.source),
          ),
        )
      await tx.insert(taskConnections).values({
        workspace_id: record.workspaceId,
        source: record.source,
        credentials,
        label: record.label,
        created_at: record.createdAt,
        deleted_at: null,
      })
    })
  }

  async softDelete(workspaceId: string, source: TaskSourceKind, at: number): Promise<void> {
    await this.db
      .update(taskConnections)
      .set({ deleted_at: at })
      .where(
        and(
          eq(taskConnections.workspace_id, workspaceId),
          eq(taskConnections.source, source),
          isNull(taskConnections.deleted_at),
        ),
      )
  }
}

/**
 * Per-workspace task-source toggle (mirrors the D1 `D1TaskSourceSettingsRepository`,
 * migration 0008). No row ⇒ enabled (the default); an `enabled: 0` row opts out.
 */
export class DrizzleTaskSourceSettingsRepository implements TaskSourceSettingsRepository {
  constructor(private readonly db: DrizzleDb) {}

  private rowToRecord(row: typeof taskSourceSettings.$inferSelect): TaskSourceSettingsRecord {
    return {
      workspaceId: row.workspace_id,
      source: row.source as TaskSourceKind,
      enabled: row.enabled !== 0,
    }
  }

  async getByWorkspace(workspaceId: string): Promise<TaskSourceSettingsRecord[]> {
    const rows = await this.db
      .select()
      .from(taskSourceSettings)
      .where(eq(taskSourceSettings.workspace_id, workspaceId))
    return rows.map((row) => this.rowToRecord(row))
  }

  async get(workspaceId: string, source: TaskSourceKind): Promise<TaskSourceSettingsRecord | null> {
    const [row] = await this.db
      .select()
      .from(taskSourceSettings)
      .where(
        and(
          eq(taskSourceSettings.workspace_id, workspaceId),
          eq(taskSourceSettings.source, source),
        ),
      )
    return row ? this.rowToRecord(row) : null
  }

  async upsert(record: TaskSourceSettingsRecord): Promise<void> {
    await this.db
      .insert(taskSourceSettings)
      .values({
        workspace_id: record.workspaceId,
        source: record.source,
        enabled: record.enabled ? 1 : 0,
      })
      .onConflictDoUpdate({
        target: [taskSourceSettings.workspace_id, taskSourceSettings.source],
        set: { enabled: record.enabled ? 1 : 0 },
      })
  }
}

function rowToTask(row: typeof tasks.$inferSelect): TaskRecord {
  return {
    workspaceId: row.workspace_id,
    source: row.source as TaskSourceKind,
    externalId: row.external_id,
    title: row.title,
    url: row.url,
    status: row.status,
    type: row.type,
    assignee: row.assignee,
    priority: row.priority,
    labels: parseJsonArray<string>(row.labels),
    description: row.description,
    comments: parseJsonArray<TaskComment>(row.comments),
    excerpt: row.excerpt,
    linkedBlockId: row.linked_block_id,
    syncedAt: row.synced_at,
    deletedAt: row.deleted_at,
  }
}

export class DrizzleTaskRepository implements TaskRepository {
  constructor(private readonly db: DrizzleDb) {}

  async upsert(record: TaskRecord): Promise<void> {
    const values = {
      workspace_id: record.workspaceId,
      source: record.source,
      external_id: record.externalId,
      title: record.title,
      url: record.url,
      status: record.status,
      type: record.type,
      assignee: record.assignee,
      priority: record.priority,
      labels: JSON.stringify(record.labels),
      description: record.description,
      comments: JSON.stringify(record.comments),
      excerpt: record.excerpt,
      linked_block_id: record.linkedBlockId,
      synced_at: record.syncedAt,
      deleted_at: null,
    }
    await this.db
      .insert(tasks)
      .values(values)
      .onConflictDoUpdate({
        target: [tasks.workspace_id, tasks.source, tasks.external_id],
        set: {
          title: values.title,
          url: values.url,
          status: values.status,
          type: values.type,
          assignee: values.assignee,
          priority: values.priority,
          labels: values.labels,
          description: values.description,
          comments: values.comments,
          excerpt: values.excerpt,
          linked_block_id: values.linked_block_id,
          synced_at: values.synced_at,
          deleted_at: null,
        },
      })
  }

  async get(
    workspaceId: string,
    source: TaskSourceKind,
    externalId: string,
  ): Promise<TaskRecord | null> {
    const [row] = await this.db
      .select()
      .from(tasks)
      .where(
        and(
          eq(tasks.workspace_id, workspaceId),
          eq(tasks.source, source),
          eq(tasks.external_id, externalId),
          isNull(tasks.deleted_at),
        ),
      )
    return row ? rowToTask(row) : null
  }

  async listByWorkspace(workspaceId: string): Promise<TaskRecord[]> {
    const rows = await this.db
      .select()
      .from(tasks)
      .where(and(eq(tasks.workspace_id, workspaceId), isNull(tasks.deleted_at)))
      .orderBy(desc(tasks.synced_at))
    return rows.map(rowToTask)
  }

  async listByBlock(workspaceId: string, blockId: string): Promise<TaskRecord[]> {
    const rows = await this.db
      .select()
      .from(tasks)
      .where(
        and(
          eq(tasks.workspace_id, workspaceId),
          eq(tasks.linked_block_id, blockId),
          isNull(tasks.deleted_at),
        ),
      )
      .orderBy(desc(tasks.synced_at))
    return rows.map(rowToTask)
  }

  async linkBlock(
    workspaceId: string,
    source: TaskSourceKind,
    externalId: string,
    blockId: string | null,
  ): Promise<void> {
    await this.db
      .update(tasks)
      .set({ linked_block_id: blockId })
      .where(
        and(
          eq(tasks.workspace_id, workspaceId),
          eq(tasks.source, source),
          eq(tasks.external_id, externalId),
        ),
      )
  }
}
