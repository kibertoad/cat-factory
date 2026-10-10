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
  ServiceCatalogConnectionRecord,
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
    try {
      return await this.runImport(workspaceId, connection)
    } catch (error) {
      // EVERY failure past the connection lookup is RECORDED before it propagates, not only a
      // transport one. `lastSyncedAt` is what the autorefresh sweep orders on and it sorts nulls
      // first, so a connection whose credential bag will not open (which fails BEFORE the portal
      // is ever contacted) would otherwise stay permanently at the head of the stale queue and
      // occupy the whole bounded batch, on every pass, silently starving every other workspace.
      // The stamp is best-effort so a failing stamp cannot replace the fault it is recording.
      await runBestEffort(
        this.log,
        'serviceCatalog.stampFailure',
        () => this.stampFailure(workspaceId, error),
        { workspaceId },
      )
      throw error
    }
  }

  /** One import, from the resolved client to the stamped verdict. Failures propagate to `sync`. */
  private async runImport(
    workspaceId: string,
    connection: ServiceCatalogConnectionRecord,
  ): Promise<ServiceCatalogSyncResult> {
    const client = await this.deps.resolveServiceCatalogClient(workspaceId)
    if (!client) {
      throw new NotFoundError('Service catalog connection', workspaceId, {
        reason: 'service_catalog_not_connected',
      })
    }
    const fetched: ServiceCatalogFetch = await client.fetchCatalog({
      entityFilter: connection.entityFilter,
      includeApis: connection.includeApis,
      maxServices: connection.maxServices,
    })
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
    const owned = await this.ownedServices(workspaceId)
    const retiring = owned.imported.filter((service) => service.deletedAt === null)
    await this.tombstone(
      workspaceId,
      retiring.map((service) => service.serviceId),
      this.deps.clock.now(),
    )
    if (retiring.length > 0) await this.deps.invalidateCatalog?.('workspace', workspaceId)
    this.log.info('serviceCatalog.retired', { workspaceId, tombstoned: retiring.length })
    return retiring.length
  }

  private async reconcile(
    workspaceId: string,
    fetched: ServiceCatalogFetch,
  ): Promise<ServiceCatalogSyncResult> {
    const { imported, foreignIds } = await this.ownedServices(workspaceId)
    const importedById = new Map(imported.map((service) => [service.serviceId, service] as const))
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
    const services: FoundationalServiceRecord[] = []
    const contractSets: { serviceId: string; contracts: ApiContractRecord[] }[] = []
    let unchanged = 0
    let contracts = 0
    let skippedConflicts = 0
    let skippedApis = fetched.skippedApis
    for (const entry of fetched.entries) {
      // A service the workspace registered by ANOTHER route owns that id, and the import yields
      // to it rather than taking it over. An upsert here would replace a hand-authored row and
      // delete its uploaded contracts, and would then hand it to `retireImported` to tombstone on
      // disconnect: the workspace would lose a service it never got from the portal.
      if (foreignIds.has(entry.id)) {
        skippedConflicts += 1
        continue
      }
      live.add(entry.id)
      const built = contractRecords(workspaceId, entry, now)
      contracts += built.records.length
      skippedApis += built.dropped
      const prior = importedById.get(entry.id)
      if (prior && !hasChanged(prior, entry, shasByService.get(entry.id) ?? [], built.records)) {
        unchanged += 1
        continue
      }
      services.push(serviceRecord(workspaceId, entry, prior, now))
      contractSets.push({ serviceId: entry.id, contracts: built.records })
    }
    // Both writes are BATCHED, in the same order one service's pair used to run in: the row
    // first, then its interfaces. A loop of single-row calls over a thousand-service estate is
    // the banned N+1, and this path is where an estate arrives whole.
    await this.deps.foundationalServiceRepository.upsertMany(services)
    await this.deps.apiContractRepository.replaceForServices('workspace', workspaceId, contractSets)
    const removed = imported
      .filter((service) => service.deletedAt === null && !live.has(service.serviceId))
      .map((service) => service.serviceId)
    await this.tombstone(workspaceId, removed, now)
    return {
      upserted: services.length,
      tombstoned: removed.length,
      unchanged,
      contracts,
      coverage: fetched.coverage,
      skippedServices: fetched.skippedEntries,
      skippedConflicts,
      skippedApis,
      status: importStatus(fetched.coverage, fetched.skippedEntries, skippedApis, skippedConflicts),
    }
  }

  /** Tombstone imported services and drop their contracts, in two batched writes. */
  private async tombstone(workspaceId: string, serviceIds: string[], now: number): Promise<void> {
    if (serviceIds.length === 0) return
    await this.deps.foundationalServiceRepository.softDeleteByIds(
      'workspace',
      workspaceId,
      serviceIds,
      now,
    )
    await this.deps.apiContractRepository.deleteForServices('workspace', workspaceId, serviceIds)
  }

  /**
   * The workspace tier split by supply route: what this connection produced, and which ids
   * something else already claims.
   *
   * Read with tombstones INCLUDED, because both halves need them and for opposite reasons. An
   * imported service the portal dropped and later restored must re-import, so its tombstone has to
   * be visible as a prior. A tombstone on a row this connection did NOT produce is a workspace's
   * own suppression of that id, which is a positive assertion about it: overwriting one would
   * silently reinstate what a human removed.
   */
  private async ownedServices(
    workspaceId: string,
  ): Promise<{ imported: FoundationalServiceRecord[]; foreignIds: Set<string> }> {
    const all = await this.deps.foundationalServiceRepository.listByOwner(
      'workspace',
      workspaceId,
      true,
    )
    const imported: FoundationalServiceRecord[] = []
    const foreignIds = new Set<string>()
    for (const service of all) {
      if (service.sourceId === SERVICE_CATALOG_SOURCE_ID) imported.push(service)
      else foreignIds.add(service.serviceId)
    }
    return { imported, foreignIds }
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

/** One imported service's row, carrying the prior's creation stamp when it had one. */
function serviceRecord(
  workspaceId: string,
  entry: ServiceCatalogEntry,
  prior: FoundationalServiceRecord | undefined,
  now: number,
): FoundationalServiceRecord {
  return {
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
  }
}

/**
 * Build one entry's contract rows, plus how many of its declared interfaces this drops.
 *
 * The count is the point of the return shape. Two interfaces of one service whose ids collide (a
 * portal that namespaces them where the platform's slug does not, two entities named alike) can
 * only produce one row, and dropping the second silently would leave the service stored publishing
 * one interface where the portal says two, with `skippedApis: 0` and a status of `ok` saying
 * nothing went missing. First one wins, as everywhere else in this import, so the survivor does
 * not flip between passes.
 */
function contractRecords(
  workspaceId: string,
  entry: ServiceCatalogEntry,
  now: number,
): { records: ApiContractRecord[]; dropped: number } {
  const records: ApiContractRecord[] = []
  const claimed = new Set<string>()
  let dropped = 0
  for (const api of entry.apis) {
    if (!api.format || claimed.has(api.id)) {
      dropped += 1
      continue
    }
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
  return { records, dropped }
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
  // A tombstoned prior always rewrites: the portal offers the service again, and the stored row
  // says the opposite until something clears its `deleted_at`.
  if (prior.deletedAt !== null) return true
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
  skippedConflicts: number,
): ServiceCatalogSyncStatus {
  const dropped = skippedServices + skippedApis + skippedConflicts
  if (coverage === 'complete' && dropped === 0) return 'ok'
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
  if (result.skippedConflicts > 0) {
    notes.push(
      `${result.skippedConflicts} portal services were not imported because this workspace already registers a service under the same id (from an upload or a linked repository). The existing service was kept untouched; rename one of the two if you want the portal's version.`,
    )
  }
  if (result.skippedApis > 0) {
    notes.push(
      `${result.skippedApis} declared interfaces were not stored: the portal returned no definition for them, declared a type this platform serves no contract format for (OpenAPI, AsyncAPI, GraphQL and gRPC are served), or named an interface whose id another interface of the same service already uses.`,
    )
  }
  return notes.length > 0 ? notes.join(' ') : null
}
