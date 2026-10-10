// Drizzle/Postgres implementation of the SERVICE CATALOG connection port: a workspace's developer
// portal (Backstage), whose services the importer turns into `workspace`-tier foundational
// services. Mirror of the D1 repository and of migration 0097 column-for-column.
//
// Its own module rather than another class in `connections.ts`, which is already the largest of
// the split repository files and covers a different family (the sealed vendor connections the
// engine PROBES). This one is read on an import path with its own sweep and its own narrow
// sync-state write.

import type {
  ServiceCatalogAuthMode,
  ServiceCatalogProvider,
  ServiceCatalogSyncStatus,
} from '@cat-factory/contracts'
import type {
  ServiceCatalogConnectionRecord,
  ServiceCatalogConnectionRepository,
} from '@cat-factory/kernel'
import { and, eq, isNull, lt, or, sql } from 'drizzle-orm'
import type { DrizzleDb } from '../../db/client.js'
import { serviceCatalogConnections } from '../../db/schema.js'

type Row = typeof serviceCatalogConnections.$inferSelect

export class DrizzleServiceCatalogConnectionRepository implements ServiceCatalogConnectionRepository {
  constructor(private readonly db: DrizzleDb) {}

  async get(workspaceId: string): Promise<ServiceCatalogConnectionRecord | null> {
    const rows = await this.db
      .select()
      .from(serviceCatalogConnections)
      .where(eq(serviceCatalogConnections.workspace_id, workspaceId))
      .limit(1)
    const row = rows[0]
    return row ? rowToRecord(row) : null
  }

  async upsert(record: ServiceCatalogConnectionRecord): Promise<void> {
    const values = {
      workspace_id: record.workspaceId,
      provider: record.provider,
      base_url: record.baseUrl,
      auth_mode: record.authMode,
      credentials: record.credentialsCipher,
      entity_filter: JSON.stringify(record.entityFilter),
      include_apis: record.includeApis,
      max_services: record.maxServices,
      last_synced_at: record.lastSyncedAt,
      last_sync_status: record.lastSyncStatus,
      last_sync_message: record.lastSyncMessage,
      created_at: record.createdAt,
      updated_at: record.updatedAt,
      deleted_at: record.deletedAt,
    }
    await this.db
      .insert(serviceCatalogConnections)
      .values(values)
      .onConflictDoUpdate({
        target: serviceCatalogConnections.workspace_id,
        set: {
          provider: values.provider,
          base_url: values.base_url,
          auth_mode: values.auth_mode,
          credentials: values.credentials,
          entity_filter: values.entity_filter,
          include_apis: values.include_apis,
          max_services: values.max_services,
          last_synced_at: values.last_synced_at,
          last_sync_status: values.last_sync_status,
          last_sync_message: values.last_sync_message,
          updated_at: values.updated_at,
          deleted_at: values.deleted_at,
        },
      })
  }

  /**
   * Stamp what one import concluded, touching nothing else.
   *
   * Narrow on purpose rather than folded into `upsert`: the importer must be able to record its
   * verdict without rewriting the credential envelope it just read through, which on a
   * mothership-mode node it holds no key to re-seal.
   */
  async updateSyncState(
    workspaceId: string,
    state: {
      lastSyncedAt: number
      lastSyncStatus: ServiceCatalogSyncStatus
      lastSyncMessage: string | null
    },
  ): Promise<void> {
    await this.db
      .update(serviceCatalogConnections)
      .set({
        last_synced_at: state.lastSyncedAt,
        last_sync_status: state.lastSyncStatus,
        last_sync_message: state.lastSyncMessage,
        updated_at: state.lastSyncedAt,
      })
      .where(eq(serviceCatalogConnections.workspace_id, workspaceId))
  }

  async softDelete(workspaceId: string, at: number): Promise<void> {
    await this.db
      .update(serviceCatalogConnections)
      // The envelope is cleared with the tombstone: a disconnected connection has no use for the
      // credential, and leaving it would keep a readable secret behind a row nothing reads.
      .set({ deleted_at: at, updated_at: at, credentials: '' })
      .where(eq(serviceCatalogConnections.workspace_id, workspaceId))
  }

  /**
   * The stalest live connections, oldest first and bounded.
   *
   * `NULLS FIRST` is explicit because Postgres orders NULLs LAST on an ascending sort, the opposite
   * of SQLite. Without it a freshly connected portal (which has never imported) would sort behind
   * every connection that has, and would wait out a staleness window it has never been inside
   * while the D1 facade imported it on the next sweep. That is exactly the kind of gap a
   * sequential conformance test passes on both runtimes.
   */
  async listStale(staleBefore: number, limit: number): Promise<ServiceCatalogConnectionRecord[]> {
    const rows = await this.db
      .select()
      .from(serviceCatalogConnections)
      .where(
        and(
          isNull(serviceCatalogConnections.deleted_at),
          or(
            isNull(serviceCatalogConnections.last_synced_at),
            lt(serviceCatalogConnections.last_synced_at, staleBefore),
          ),
        ),
      )
      .orderBy(sql`${serviceCatalogConnections.last_synced_at} ASC NULLS FIRST`)
      .limit(limit)
    return rows.map(rowToRecord)
  }
}

function rowToRecord(row: Row): ServiceCatalogConnectionRecord {
  return {
    workspaceId: row.workspace_id,
    provider: row.provider as ServiceCatalogProvider,
    baseUrl: row.base_url,
    authMode: row.auth_mode as ServiceCatalogAuthMode,
    credentialsCipher: row.credentials,
    entityFilter: parseFilter(row.entity_filter),
    includeApis: row.include_apis,
    maxServices: row.max_services,
    lastSyncedAt: row.last_synced_at,
    lastSyncStatus: (row.last_sync_status as ServiceCatalogSyncStatus | null) ?? null,
    lastSyncMessage: row.last_sync_message,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    deletedAt: row.deleted_at,
  }
}

/**
 * The stored filter, or an EMPTY list when the column does not hold an array of strings.
 *
 * Empty rather than the default filter, for the reason the D1 twin gives: the write boundary is
 * what substitutes a default, so an empty value here can only be a corrupt row, and the import
 * refuses an empty filter by name rather than importing under a narrowing nobody chose.
 */
function parseFilter(value: string): string[] {
  try {
    const parsed: unknown = JSON.parse(value)
    if (!Array.isArray(parsed)) return []
    return parsed.filter((term): term is string => typeof term === 'string')
  } catch {
    // silent-catch-ok: the parse error names only JSON syntax; the import's named refusal is what
    // a human sees.
    return []
  }
}
