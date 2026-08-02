import type {
  ApiContractFormat,
  FoundationalServiceOwnerKind,
  FoundationalServiceSourceMode,
} from '@cat-factory/contracts'

// ---------------------------------------------------------------------------
// Persistence ports for the FOUNDATIONAL SERVICES catalog
// (backend/docs/adr/0031-foundational-services.md). Rows are scoped by an
// `(ownerKind, ownerId)` pair — an account id or a workspace id — so one table
// backs both tenancy tiers, exactly like the prompt-fragment library, and carry a
// tombstone so a workspace can suppress an inherited account service.
//
// The split into TWO repositories is the feature's core constraint, not tidiness:
// the Architect's catalog read must never touch a contract BODY (an OpenAPI
// document routinely runs to hundreds of kilobytes and there is one per service),
// while a downstream consumer reads the bodies for the handful of services the
// design declared. Keeping identity and documents in separate tables is what makes
// "lazily read api details" a property of the schema rather than a discipline every
// caller has to remember.
// ---------------------------------------------------------------------------

/** A stored contract document. Bodies live here and ONLY here. */
export interface ApiContractRecord {
  ownerKind: FoundationalServiceOwnerKind
  ownerId: string
  serviceId: string
  /** Stable slug within the service — the file's basename, or the uploader's choice. */
  contractId: string
  format: ApiContractFormat
  title: string
  /** The document verbatim: OpenAPI JSON/YAML, or a contract module's TypeScript source. */
  body: string
  /**
   * The operations an OpenAPI document declares, indexed ONCE at write time
   * (`indexOpenApiOperations`) and stored, so the catalog read can show an agent what the
   * interface offers without ever loading a document body. Empty for the TypeScript formats,
   * which are not parsed.
   */
  operations: string[]
  /** How many operations the cap dropped from {@link operations}; states the list is a prefix. */
  omittedOperations: number
  /** Repo provenance (path + blob sha), both null for a direct upload. */
  sourcePath: string | null
  sourceSha: string | null
  createdAt: number
  updatedAt: number
}

/**
 * A contract row WITHOUT its body — the manifest the catalog read joins onto each service.
 * `size` is a SQL `length()`, so listing a tier's catalog reads no document bytes at all.
 */
export interface ApiContractManifestEntry {
  serviceId: string
  contractId: string
  format: ApiContractFormat
  title: string
  size: number
  operations: string[]
  omittedOperations: number
  sourcePath: string | null
}

export interface ApiContractRepository {
  /**
   * The whole tier's contract manifest — one query, no bodies. Indexed by the caller into a
   * `serviceId → entries` Map, so building a catalog of N services costs ONE read rather than
   * N (see CLAUDE.md "No N+1 repository access").
   */
  listManifestByOwner(
    ownerKind: FoundationalServiceOwnerKind,
    ownerId: string,
  ): Promise<ApiContractManifestEntry[]>
  /**
   * The full documents for a SET of services, in one chunked `IN` query. This is the lazy
   * read: it is called once per dispatch with exactly the ids the design declared. An empty
   * `serviceIds` is a no-op returning `[]`, never a full-table read.
   */
  listByServiceIds(
    ownerKind: FoundationalServiceOwnerKind,
    ownerId: string,
    serviceIds: string[],
  ): Promise<ApiContractRecord[]>
  /**
   * REPLACE a service's whole contract set. A contract document has no meaningful partial
   * edit, and the sync path recomputes the set from the repo tree each pass, so both callers
   * want replace semantics — expressing it as one method keeps "removed upstream" from
   * needing a per-row diff at every call site.
   */
  replaceForService(
    ownerKind: FoundationalServiceOwnerKind,
    ownerId: string,
    serviceId: string,
    contracts: ApiContractRecord[],
  ): Promise<void>
  /** Drop every contract of a service (its row was deleted or tombstoned). */
  deleteForService(
    ownerKind: FoundationalServiceOwnerKind,
    ownerId: string,
    serviceId: string,
  ): Promise<void>
}

/** A registered foundational service at one tier. */
export interface FoundationalServiceRecord {
  serviceId: string
  ownerKind: FoundationalServiceOwnerKind
  ownerId: string
  name: string
  summary: string
  description: string
  capabilities: string[]
  /** Provenance when repo-sourced (null for a hand-registered / uploaded service). */
  sourceId: string | null
  sourcePath: string | null
  /** Head commit the service's directory was pinned to at the last sync. */
  pinnedCommit: string | null
  createdAt: number
  updatedAt: number
  /** Tombstone: removed upstream, unlinked, or suppressed by this tier. */
  deletedAt: number | null
}

export interface FoundationalServiceRepository {
  /**
   * Services owned by `(ownerKind, ownerId)`. Excludes tombstones by default; pass
   * `includeDeleted` for the tier merge, which must SEE a workspace tombstone in order to
   * suppress the account service it shadows.
   */
  listByOwner(
    ownerKind: FoundationalServiceOwnerKind,
    ownerId: string,
    includeDeleted?: boolean,
  ): Promise<FoundationalServiceRecord[]>
  get(
    ownerKind: FoundationalServiceOwnerKind,
    ownerId: string,
    serviceId: string,
  ): Promise<FoundationalServiceRecord | null>
  upsert(record: FoundationalServiceRecord): Promise<void>
  softDelete(
    ownerKind: FoundationalServiceOwnerKind,
    ownerId: string,
    serviceId: string,
    at: number,
  ): Promise<void>
  /**
   * Remove a row OUTRIGHT rather than tombstoning it. The tombstone is a positive assertion —
   * "this tier suppresses that id" — so restoring an inherited service cannot be expressed as
   * another write: clearing `deleted_at` would revive a suppression row that carries no name or
   * summary and let it WIN the merge as an empty override. Deleting the row is the only shape
   * that returns the tier to "says nothing about this id".
   */
  hardDelete(
    ownerKind: FoundationalServiceOwnerKind,
    ownerId: string,
    serviceId: string,
  ): Promise<void>
  /** Live services produced by a given source, for resync diffing/tombstoning. */
  listBySource(sourceId: string): Promise<FoundationalServiceRecord[]>
  /** Tombstone EVERY live service a source produced, in one write (used on unlink). */
  softDeleteBySource(sourceId: string, at: number): Promise<void>
}

/** A repo linked as a source of foundational-service definitions. */
export interface FoundationalServiceSourceRecord {
  id: string
  ownerKind: FoundationalServiceOwnerKind
  ownerId: string
  repoOwner: string
  repoName: string
  gitRef: string
  /**
   * `directory` scans `<dirPath>/<service>/`; `folder` scans the whole of `<dirPath>` for ONE
   * service's contracts; `files` reads an explicit path list.
   */
  mode: FoundationalServiceSourceMode
  /**
   * The subtree scanned in `directory` and `folder` mode. In `files` mode it is the DEEPEST
   * COMMON directory of the linked files, which is what the head-commit probe anchors on — so a
   * `files` source detects an upstream change with the same single cheap read a `directory`
   * one does, rather than a probe per file.
   */
  dirPath: string
  /**
   * `folder` mode only: whether the scan descends into `dirPath`'s subfolders. False in the
   * other modes, where a subtree is either the service list itself or not walked at all.
   */
  recursive: boolean
  /** `files` mode only: repo-root-relative contract file paths. */
  filePaths: string[]
  /** `folder`/`files` mode: the service the linked contracts describe. */
  serviceId: string | null
  serviceName: string | null
  serviceSummary: string | null
  lastSyncedCommit: string | null
  lastSyncedAt: number | null
  createdAt: number
  deletedAt: number | null
}

export interface FoundationalServiceSourceRepository {
  listByOwner(
    ownerKind: FoundationalServiceOwnerKind,
    ownerId: string,
  ): Promise<FoundationalServiceSourceRecord[]>
  /**
   * Live sources pointing at one repo, across every tier — the PUSH-webhook fan-out's only
   * query. A delivery names `owner/name` and nothing else, so this is indexed on that pair
   * rather than on an owner: the whole point is to find the handful of tiers that linked the
   * repo without enumerating accounts and workspaces (which would be a deployment-wide N+1 on
   * every push).
   */
  listByRepo(repoOwner: string, repoName: string): Promise<FoundationalServiceSourceRecord[]>
  get(id: string): Promise<FoundationalServiceSourceRecord | null>
  upsert(record: FoundationalServiceSourceRecord): Promise<void>
  updateSyncState(id: string, lastSyncedCommit: string | null, lastSyncedAt: number): Promise<void>
  softDelete(id: string, at: number): Promise<void>
  /**
   * Live sources across every tier whose last sync is older than `staleBefore` (or which have
   * never synced), oldest first and bounded. This is the AUTOREFRESH sweep's only query: the
   * cron pass on each facade drains a bounded batch, so a deployment with a thousand linked
   * sources refreshes them over successive ticks instead of in one unbounded pass.
   */
  listStale(staleBefore: number, limit: number): Promise<FoundationalServiceSourceRecord[]>
}

/**
 * A targeted foundational-source resync, enqueued by the push-webhook fan-out onto the runtime's
 * GitHub-sync queue, so a contract changed upstream reaches the catalog in seconds rather than
 * waiting out the autorefresh sweep's staleness window.
 *
 * It carries only the source id, unlike the skill library's account-keyed twin: a foundational
 * source belongs to an `(ownerKind, ownerId)` PAIR, and `syncById` already resolves that pair off
 * the stored row. Restating it on the message would put a second copy of the ownership on the
 * queue — one that a re-tiered source could contradict by the time the job runs.
 */
export interface FoundationalSourceResyncRequest {
  sourceId: string
}
