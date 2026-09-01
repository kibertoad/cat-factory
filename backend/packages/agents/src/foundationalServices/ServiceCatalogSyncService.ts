import type {
  ServiceCatalogCoverage,
  ServiceCatalogSyncResult,
  ServiceCatalogSyncStatus,
} from '@cat-factory/contracts'
import type {
  ApiContractRecord,
  ApiContractRepository,
  Clock,
  FoundationalServiceRecord,
  FoundationalServiceRepository,
  Logger,
  ResolveServiceCatalogClient,
  ServiceCatalogApi,
  ServiceCatalogConnectionRepository,
  ServiceCatalogEntry,
  ServiceCatalogFetch,
} from '@cat-factory/kernel'
import {
  NotFoundError,
  describeError,
  getErrorMessage,
  noopLogger,
  runBestEffort,
  summarizeContract,
} from '@cat-factory/kernel'

// ---------------------------------------------------------------------------
// The IMPORTER: one workspace's developer portal into the foundational-services catalog.
//
// It writes ordinary `workspace`-tier foundational services, which is the whole design. Every
// agent-facing read (the design catalog, the lazily-resolved contract documents, the estate file
// a triage kind gets), the tiered merge, the suppression sub-resource and the SPA's catalog list
// work on an imported service exactly as they do on an uploaded one, because there is no second
// mechanism for any of them to disagree about.
//
// Vendor-neutral by construction: it consumes the kernel's `ServiceCatalogEntry` vocabulary and
// names no portal product. The Backstage-specific half is the adapter behind
// `ResolveServiceCatalogClient` in `@cat-factory/integrations`.
// ---------------------------------------------------------------------------

/**
 * The `sourceId` every imported service carries.
 *
 * A FIXED literal rather than a generated id, because there is exactly one connection per
 * workspace and the rows are already owner-scoped: what the value has to do is separate "this
 * workspace's imported services" from its hand-registered and repo-sourced ones, which one
 * constant does. The importer therefore never uses the source-keyed repository reads, whose
 * lookup is global across tiers and would need a source row that does not exist here.
 */
export const SERVICE_CATALOG_SOURCE_ID = 'service-catalog'

export interface ServiceCatalogSyncServiceDependencies {
  serviceCatalogConnectionRepository: ServiceCatalogConnectionRepository
  resolveServiceCatalogClient: ResolveServiceCatalogClient
  foundationalServiceRepository: FoundationalServiceRepository
  apiContractRepository: ApiContractRepository
  clock: Clock
  logger?: Logger
  /** Drops the cached merged catalog for the workspace after an import changed a row. */
  invalidateCatalog?: (ownerKind: 'workspace', ownerId: string) => Promise<void>
}

export class ServiceCatalogSyncService {
  private readonly log: Logger

  constructor(private readonly deps: ServiceCatalogSyncServiceDependencies) {
    this.log = deps.logger ?? noopLogger
  }

  /**
   * Import the workspace's portal into its foundational-services tier.
   *
   * Throws when the workspace has no connection: the caller asked to import from a portal that is
   * not configured, and answering an empty result would report a successful import of nothing.
   */
  async sync(workspaceId: string): Promise<ServiceCatalogSyncResult> {
    const connection = await this.deps.serviceCatalogConnectionRepository.get(workspaceId)
    if (!connection || connection.deletedAt !== null) {
      throw new NotFoundError('Service catalog connection', workspaceId, {
        reason: 'service_catalog_not_connected',
      })
    }
    const client = await this.deps.resolveServiceCatalogClient(workspaceId)
    if (!client) {
      throw new NotFoundError('Service catalog connection', workspaceId, {
        reason: 'service_catalog_not_connected',
      })
    }
    let fetched: ServiceCatalogFetch
    try {
      fetched = await client.fetchCatalog({
        entityFilter: connection.entityFilter,
        includeApis: connection.includeApis,
        maxServices: connection.maxServices,
      })
    } catch (error) {
      // The failure is RECORDED before it propagates, so the management surface can say the last
      // import failed and why. Stamping only on success would leave a workspace whose portal has
      // been unreachable for a week showing the verdict of the last pass that worked.
      await this.stampFailure(workspaceId, error)
      throw error
    }
    const result = await this.reconcile(workspaceId, fetched)
    await this.deps.serviceCatalogConnectionRepository.updateSyncState(workspaceId, {
      lastSyncedAt: this.deps.clock.now(),
      lastSyncStatus: result.status,
      lastSyncMessage: describeImport(result),
    })
    if (result.upserted > 0 || result.tombstoned > 0) {
      await this.deps.invalidateCatalog?.('workspace', workspaceId)
    }
    this.log.info('serviceCatalog.imported', { workspaceId, ...result })
    return result
  }

  /**
   * Refresh the stalest connections, bounded, for the autorefresh sweep.
   *
   * Returns how many were IMPORTED, not how many were attempted: each failure is recorded on its
   * own connection (`lastSyncStatus: 'failed'`) and logged with its cause, and the pass continues.
   * One workspace's revoked portal token must not stop everyone else's estate from refreshing,
   * which is exactly what a single rejection out of this loop would do.
   */
  async refreshStale(staleMs: number, limit: number): Promise<number> {
    const stale = await this.deps.serviceCatalogConnectionRepository.listStale(
      this.deps.clock.now() - staleMs,
      limit,
    )
    let imported = 0
    for (const connection of stale) {
      const result = await runBestEffort(
        this.log,
        'serviceCatalog.refreshStale',
        () => this.sync(connection.workspaceId),
        { workspaceId: connection.workspaceId },
      )
      if (result) imported += 1
    }
    return imported
  }

  /**
   * Retire everything the connection imported, on disconnect.
   *
   * Tombstoning rather than leaving the rows is the point: an imported estate that nothing
   * refreshes still reads to every agent as the organisation's current estate, which is worse
   * than having none because nothing about it says it is stale.
   */
  async retireImported(workspaceId: string): Promise<number> {
    const existing = await this.importedServices(workspaceId)
    const now = this.deps.clock.now()
    for (const service of existing) {
      await this.tombstone(workspaceId, service.serviceId, now)
    }
    if (existing.length > 0) await this.deps.invalidateCatalog?.('workspace', workspaceId)
    this.log.info('serviceCatalog.retired', { workspaceId, tombstoned: existing.length })
    return existing.length
  }

  private async reconcile(
    workspaceId: string,
    fetched: ServiceCatalogFetch,
  ): Promise<ServiceCatalogSyncResult> {
    const existing = await this.importedServices(workspaceId)
    const existingById = new Map(existing.map((service) => [service.serviceId, service] as const))
    // ONE manifest read for the whole tier, indexed per service: the alternative is a contract
    // read per imported service, which is the N+1 the batch ports exist to prevent.
    const manifest = await this.deps.apiContractRepository.listManifestByOwner(
      'workspace',
      workspaceId,
    )
    const shasByService = new Map<string, string[]>()
    for (const entry of manifest) {
      const shas = shasByService.get(entry.serviceId) ?? []
      shas.push(`${entry.contractId}@${entry.sourceSha ?? ''}`)
      shasByService.set(entry.serviceId, shas)
    }
    const now = this.deps.clock.now()
    const live = new Set<string>()
    let upserted = 0
    let unchanged = 0
    let contracts = 0
    for (const entry of fetched.entries) {
      live.add(entry.id)
      const records = contractRecords(workspaceId, entry, now)
      contracts += records.length
      const prior = existingById.get(entry.id)
      if (prior && !hasChanged(prior, entry, shasByService.get(entry.id) ?? [], records)) {
        unchanged += 1
        continue
      }
      await this.write(workspaceId, entry, records, prior, now)
      upserted += 1
    }
    let tombstoned = 0
    for (const service of existing) {
      if (live.has(service.serviceId)) continue
      await this.tombstone(workspaceId, service.serviceId, now)
      tombstoned += 1
    }
    return {
      upserted,
      tombstoned,
      unchanged,
      contracts,
      coverage: fetched.coverage,
      skippedServices: fetched.skippedEntries,
      skippedApis: fetched.skippedApis,
      status: importStatus(fetched.coverage, fetched.skippedEntries, fetched.skippedApis),
    }
  }

  private async write(
    workspaceId: string,
    entry: ServiceCatalogEntry,
    records: ApiContractRecord[],
    prior: FoundationalServiceRecord | undefined,
    now: number,
  ): Promise<void> {
    await this.deps.foundationalServiceRepository.upsert({
      serviceId: entry.id,
      ownerKind: 'workspace',
      ownerId: workspaceId,
      name: entry.name,
      summary: entry.summary,
      description: entry.description,
      capabilities: entry.capabilities,
      sourceId: SERVICE_CATALOG_SOURCE_ID,
      sourcePath: entry.ref,
      // An imported service pins no commit: it is not repo-sourced, and putting the portal's
      // entity revision in a field named for a git commit would be a fact stated in the wrong
      // vocabulary. Whether the service changed is decided by comparing its own fields and its
      // interfaces' content identities, which is what `hasChanged` does.
      pinnedCommit: null,
      createdAt: prior?.createdAt ?? now,
      updatedAt: now,
      deletedAt: null,
    })
    await this.deps.apiContractRepository.replaceForService(
      'workspace',
      workspaceId,
      entry.id,
      records,
    )
  }

  private async tombstone(workspaceId: string, serviceId: string, now: number): Promise<void> {
    await this.deps.foundationalServiceRepository.softDelete(
      'workspace',
      workspaceId,
      serviceId,
      now,
    )
    await this.deps.apiContractRepository.deleteForService('workspace', workspaceId, serviceId)
  }

  /** The workspace's live services that this connection produced. */
  private async importedServices(workspaceId: string): Promise<FoundationalServiceRecord[]> {
    const all = await this.deps.foundationalServiceRepository.listByOwner('workspace', workspaceId)
    return all.filter((service) => service.sourceId === SERVICE_CATALOG_SOURCE_ID)
  }

  private async stampFailure(workspaceId: string, error: unknown): Promise<void> {
    await this.deps.serviceCatalogConnectionRepository.updateSyncState(workspaceId, {
      lastSyncedAt: this.deps.clock.now(),
      lastSyncStatus: 'failed',
      lastSyncMessage: getErrorMessage(error),
    })
    this.log.warn('serviceCatalog.importFailed', {
      workspaceId,
      ...describeError(error),
    })
  }
}

/** Build one entry's contract rows, dropping the interfaces the adapter could not serve. */
function contractRecords(
  workspaceId: string,
  entry: ServiceCatalogEntry,
  now: number,
): ApiContractRecord[] {
  const records: ApiContractRecord[] = []
  const claimed = new Set<string>()
  for (const api of entry.apis) {
    if (!api.format || claimed.has(api.id)) continue
    claimed.add(api.id)
    const summary = summarizeContract({
      contractId: api.id,
      format: api.format,
      title: api.title,
      path: api.ref,
      body: api.definition,
    })
    records.push({
      ownerKind: 'workspace',
      ownerId: workspaceId,
      serviceId: entry.id,
      contractId: api.id,
      format: api.format,
      title: summary.title,
      body: api.definition,
      operations: summary.operations,
      omittedOperations: summary.omittedOperations,
      sourcePath: api.ref,
      sourceSha: contractRevision(api),
      createdAt: now,
      updatedAt: now,
    })
  }
  return records
}

/**
 * The content identity stored for one imported interface.
 *
 * The portal's own revision when it exposes one, and a digest of the definition otherwise. The
 * fallback is not a nicety: not every portal (or every entity in one) carries a change token, and
 * without an identity the import can only either rewrite every document on every pass or report a
 * changed document as unchanged. Both are worse than hashing bytes already in memory.
 */
function contractRevision(api: ServiceCatalogApi): string {
  return api.revision ?? `sha:${digest(api.definition)}`
}

/**
 * A short, stable, NON-cryptographic digest (FNV-1a, hex).
 *
 * Non-cryptographic on purpose and safe here, because nothing trusts it: it decides only whether
 * to rewrite a row this pass, and the worst a collision can do is skip one rewrite of a document
 * the next pass will reconsider. A real hash would mean an async WebCrypto call per definition
 * inside the reconcile loop, bought with nothing.
 */
function digest(value: string): string {
  let hash = 0x811c9dc5
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(16).padStart(8, '0')
}

/**
 * Whether an imported service needs rewriting: any of its own fields, or its interface set's
 * content identities, differ from what is stored.
 *
 * Compared field by field rather than through a stored digest of the whole row, because the fields
 * are already in hand from the one `listByOwner` the reconcile does, and a digest column would be
 * a second thing to keep in step with the fields it summarises.
 */
function hasChanged(
  prior: FoundationalServiceRecord,
  entry: ServiceCatalogEntry,
  priorContractKeys: string[],
  records: ApiContractRecord[],
): boolean {
  if (prior.name !== entry.name) return true
  if (prior.summary !== entry.summary) return true
  if (prior.description !== entry.description) return true
  if (prior.sourcePath !== entry.ref) return true
  if (!sameList(prior.capabilities, entry.capabilities)) return true
  const nextKeys = records.map((record) => `${record.contractId}@${record.sourceSha ?? ''}`)
  return !sameList(priorContractKeys.slice().sort(), nextKeys.slice().sort())
}

/** Element-wise equality, so no separator has to be assumed absent from a value. */
function sameList(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index])
}

/**
 * What the pass concluded.
 *
 * `empty` is `partial` rather than `ok`, because a filter that matched nothing is a configuration
 * problem with a remedy (edit the filter), and reporting it as a healthy import of zero services
 * is exactly how a workspace ends up believing its estate is empty.
 */
function importStatus(
  coverage: ServiceCatalogCoverage,
  skippedServices: number,
  skippedApis: number,
): ServiceCatalogSyncStatus {
  if (coverage === 'complete' && skippedServices === 0 && skippedApis === 0) return 'ok'
  return 'partial'
}

/**
 * The sentence the management surface shows, or null when the pass has nothing to report.
 *
 * Null for a clean pass rather than "imported N services": the field exists to name what a human
 * has to fix, and filling it on every success is how the one pass that needs reading stops
 * standing out.
 */
export function describeImport(result: ServiceCatalogSyncResult): string | null {
  const notes: string[] = []
  if (result.coverage === 'truncated') {
    notes.push(
      `The import stopped at the configured service cap after ${result.upserted + result.unchanged} services, so this catalog is a PREFIX of the portal's estate. Narrow the entity filter, or raise the cap.`,
    )
  }
  if (result.coverage === 'empty') {
    notes.push(
      'The entity filter matched nothing in the portal, so no services were imported. Check the filter terms against the kinds, tags and systems this instance actually uses.',
    )
  }
  if (result.skippedServices > 0) {
    notes.push(
      `${result.skippedServices} matching entities could not be imported (no usable name, or a name that collides with another service's).`,
    )
  }
  if (result.skippedApis > 0) {
    notes.push(
      `${result.skippedApis} declared interfaces were not stored: the portal returned no definition for them, or declared a type this platform serves no contract format for (OpenAPI, AsyncAPI, GraphQL and gRPC are served).`,
    )
  }
  return notes.length > 0 ? notes.join(' ') : null
}
