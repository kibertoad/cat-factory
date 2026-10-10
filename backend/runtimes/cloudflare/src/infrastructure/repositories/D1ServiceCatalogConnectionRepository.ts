import type {
  ServiceCatalogAuthMode,
  ServiceCatalogProvider,
  ServiceCatalogSyncStatus,
} from '@cat-factory/contracts'
import type {
  ServiceCatalogConnectionRecord,
  ServiceCatalogConnectionRepository,
} from '@cat-factory/kernel'

// D1-backed store for a workspace's SERVICE CATALOG connection (the developer portal whose
// services are imported into the foundational-services catalog). Mirror of migration 0097 and of
// the Node Drizzle repository column-for-column.
//
// The repository never decrypts: `credentials` travels as the sealed envelope the service layer
// opens, which is what lets the row cross the mothership persistence RPC while the key stays on
// the mothership (`docs/initiatives/mothership-mode.md`).

interface ServiceCatalogConnectionRow {
  workspace_id: string
  provider: string
  base_url: string
  auth_mode: string
  credentials: string
  entity_filter: string
  include_apis: number
  max_services: number
  last_synced_at: number | null
  last_sync_status: string | null
  last_sync_message: string | null
  created_at: number
  updated_at: number
  deleted_at: number | null
}

export class D1ServiceCatalogConnectionRepository implements ServiceCatalogConnectionRepository {
  private readonly db: D1Database

  constructor({ db }: { db: D1Database }) {
    this.db = db
  }

  async get(workspaceId: string): Promise<ServiceCatalogConnectionRecord | null> {
    const row = await this.db
      .prepare(`SELECT * FROM service_catalog_connections WHERE workspace_id = ?`)
      .bind(workspaceId)
      .first<ServiceCatalogConnectionRow>()
    return row ? rowToRecord(row) : null
  }

  async upsert(record: ServiceCatalogConnectionRecord): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO service_catalog_connections
           (workspace_id, provider, base_url, auth_mode, credentials, entity_filter,
            include_apis, max_services, last_synced_at, last_sync_status, last_sync_message,
            created_at, updated_at, deleted_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (workspace_id) DO UPDATE SET
           provider = excluded.provider,
           base_url = excluded.base_url,
           auth_mode = excluded.auth_mode,
           credentials = excluded.credentials,
           entity_filter = excluded.entity_filter,
           include_apis = excluded.include_apis,
           max_services = excluded.max_services,
           last_synced_at = excluded.last_synced_at,
           last_sync_status = excluded.last_sync_status,
           last_sync_message = excluded.last_sync_message,
           updated_at = excluded.updated_at,
           deleted_at = excluded.deleted_at`,
      )
      .bind(
        record.workspaceId,
        record.provider,
        record.baseUrl,
        record.authMode,
        record.credentialsCipher,
        JSON.stringify(record.entityFilter),
        record.includeApis ? 1 : 0,
        record.maxServices,
        record.lastSyncedAt,
        record.lastSyncStatus,
        record.lastSyncMessage,
        record.createdAt,
        record.updatedAt,
        record.deletedAt,
      )
      .run()
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
      .prepare(
        `UPDATE service_catalog_connections
            SET last_synced_at = ?, last_sync_status = ?, last_sync_message = ?, updated_at = ?
          WHERE workspace_id = ?`,
      )
      .bind(
        state.lastSyncedAt,
        state.lastSyncStatus,
        state.lastSyncMessage,
        state.lastSyncedAt,
        workspaceId,
      )
      .run()
  }

  async softDelete(workspaceId: string, at: number): Promise<void> {
    await this.db
      .prepare(
        `UPDATE service_catalog_connections
            SET deleted_at = ?, updated_at = ?, credentials = ''
          WHERE workspace_id = ?`,
      )
      .bind(at, at, workspaceId)
      .run()
  }

  /**
   * The stalest live connections, oldest first and bounded.
   *
   * `last_synced_at IS NULL` sorts FIRST (SQLite orders NULLs low on an ascending sort), which is
   * what makes a freshly connected portal import on the very next sweep rather than waiting out a
   * staleness window it has never been inside.
   */
  async listStale(staleBefore: number, limit: number): Promise<ServiceCatalogConnectionRecord[]> {
    const { results } = await this.db
      .prepare(
        `SELECT * FROM service_catalog_connections
          WHERE deleted_at IS NULL
            AND (last_synced_at IS NULL OR last_synced_at < ?)
          ORDER BY last_synced_at ASC
          LIMIT ?`,
      )
      .bind(staleBefore, limit)
      .all<ServiceCatalogConnectionRow>()
    return results.map(rowToRecord)
  }
}

function rowToRecord(row: ServiceCatalogConnectionRow): ServiceCatalogConnectionRecord {
  return {
    workspaceId: row.workspace_id,
    provider: row.provider as ServiceCatalogProvider,
    baseUrl: row.base_url,
    authMode: row.auth_mode as ServiceCatalogAuthMode,
    credentialsCipher: row.credentials,
    entityFilter: parseFilter(row.entity_filter),
    includeApis: row.include_apis !== 0,
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
 * Empty rather than the default filter, because the two say different things: the write boundary
 * is what substitutes a default, so an empty value here can only be a corrupt row. The import
 * REFUSES an empty filter by name, where silently substituting `kind=component` would import
 * under a narrowing nobody chose and look like it worked.
 */
function parseFilter(value: string): string[] {
  try {
    const parsed: unknown = JSON.parse(value)
    if (!Array.isArray(parsed)) return []
    return parsed.filter((term): term is string => typeof term === 'string')
  } catch {
    // silent-catch-ok: an unparseable column is a corrupt row, and the parse error names only
    // JSON syntax. The empty list is the honest reading, and the import's own named refusal is
    // what a human sees.
    return []
  }
}
