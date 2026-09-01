import type {
  ServiceCatalogAuthMode,
  ServiceCatalogProvider,
  ServiceCatalogSyncStatus,
} from '@cat-factory/contracts'

// ---------------------------------------------------------------------------
// Persistence port for a workspace's SERVICE CATALOG connection: the developer portal
// (Backstage today) whose services are imported into the foundational-services catalog.
//
// One row per workspace, exactly like `observability_connections`: a workspace either points at
// a portal or it does not, and a second connection would give the import two estates to
// reconcile one catalog against. The credential bag is SEALED and the row carries only the
// envelope, so a mothership-mode node can hold the row (the persistence RPC) without holding
// the key (the secret delegation opens it by naming the row).
// ---------------------------------------------------------------------------

/** The stored connection. Never plaintext: `credentialsCipher` is a sealed envelope. */
export interface ServiceCatalogConnectionRecord {
  workspaceId: string
  provider: ServiceCatalogProvider
  /** The portal's base URL, normalised (no trailing slash) at the write boundary. */
  baseUrl: string
  /**
   * Which scheme the sealed bag holds credentials for. A COLUMN rather than a field inside the
   * envelope, because it is configuration rather than secret: the management read has to say
   * which scheme a stored connection uses without opening anything, and the importer picks its
   * request builder off it before it decides whether it needs the bag at all (`none` needs no
   * open, so an unauthenticated portal keeps working on a deployment whose key drifted).
   */
  authMode: ServiceCatalogAuthMode
  /** Sealed JSON credential bag; the empty string for `authMode: 'none'`, which holds none. */
  credentialsCipher: string
  /** Portal-side filter terms, ANDed. JSON `string[]` on the wire to the runtimes. */
  entityFilter: string[]
  includeApis: boolean
  maxServices: number
  lastSyncedAt: number | null
  lastSyncStatus: ServiceCatalogSyncStatus | null
  /** What the last import wants a human to know; null when it had nothing to report. */
  lastSyncMessage: string | null
  createdAt: number
  updatedAt: number
  /** Tombstone: the workspace disconnected. */
  deletedAt: number | null
}

export interface ServiceCatalogConnectionRepository {
  get(workspaceId: string): Promise<ServiceCatalogConnectionRecord | null>
  upsert(record: ServiceCatalogConnectionRecord): Promise<void>
  /**
   * Stamp what one import concluded. Its own method rather than a full `upsert`, because the
   * import must never rewrite the credential envelope it just read through: an upsert here would
   * re-seal the bag under whatever key the syncing process holds, which on a mothership-mode
   * node is not the key the row was sealed with.
   */
  updateSyncState(
    workspaceId: string,
    state: {
      lastSyncedAt: number
      lastSyncStatus: ServiceCatalogSyncStatus
      lastSyncMessage: string | null
    },
  ): Promise<void>
  softDelete(workspaceId: string, at: number): Promise<void>
  /**
   * Live connections whose last import is older than `staleBefore` (or which never ran), oldest
   * first and bounded. The AUTOREFRESH sweep's only query.
   *
   * Unscoped across workspaces by construction, which is why it is the one method that stays OFF
   * the mothership persistence allow-list: it runs on the deployment that holds the portal
   * credentials, which is never a laptop.
   */
  listStale(staleBefore: number, limit: number): Promise<ServiceCatalogConnectionRecord[]>
}
