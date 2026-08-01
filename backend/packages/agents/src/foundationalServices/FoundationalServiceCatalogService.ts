import type {
  ApiContractDocument,
  CreateFoundationalServiceInput,
  FoundationalService,
  FoundationalServiceOwnerKind,
  ResolvedFoundationalService,
  UpdateFoundationalServiceInput,
} from '@cat-factory/contracts'
import type {
  ApiContractManifestEntry,
  ApiContractRecord,
  ApiContractRepository,
  Clock,
  FoundationalServiceRecord,
  FoundationalServiceRepository,
  GroupCacheHandle,
  WorkspaceRepository,
} from '@cat-factory/kernel'
import {
  ConflictError,
  NotFoundError,
  ValidationError,
  documentSize,
  summarizeContract,
} from '@cat-factory/kernel'
import { mergeFoundationalTiers, toWire } from './foundational-catalog.js'
import { validateUploadedContract } from './contract-validation.js'

export interface FoundationalServiceCatalogDependencies {
  foundationalServiceRepository: FoundationalServiceRepository
  apiContractRepository: ApiContractRepository
  workspaceRepository: WorkspaceRepository
  clock: Clock
  /** The merged per-workspace catalog cache. Absent (tests) ⇒ every resolve reads through. */
  catalogCache?: GroupCacheHandle<ResolvedFoundationalService[]>
}

/**
 * The foundational-services catalog (docs/initiatives/foundational-services.md): per-tier CRUD
 * plus the merged account ⊕ workspace resolve every design dispatch reads.
 *
 * Two properties are load-bearing and are why this is a service rather than a repository call:
 *
 * - **The catalog never carries a contract BODY.** `listTier` and `resolve` join the contract
 *   MANIFEST (id, format, title, byte size, operation names) onto each service in ONE extra
 *   query for the whole tier. The documents are read only by {@link contractsFor}, and only for
 *   the ids a caller asks for.
 * - **A workspace row wins over an account row of the same id, and a workspace TOMBSTONE
 *   suppresses one.** That is what lets a board opt out of an org-wide service without an
 *   account admin, and it is why the merge reads the workspace tier `includeDeleted`.
 */
export class FoundationalServiceCatalogService {
  constructor(private readonly deps: FoundationalServiceCatalogDependencies) {}

  /** One tier's registered services, contract manifests joined on. Raw — not merged. */
  async listTier(
    ownerKind: FoundationalServiceOwnerKind,
    ownerId: string,
  ): Promise<FoundationalService[]> {
    const [records, manifest] = await Promise.all([
      this.deps.foundationalServiceRepository.listByOwner(ownerKind, ownerId),
      this.deps.apiContractRepository.listManifestByOwner(ownerKind, ownerId),
    ])
    const byService = indexManifest(manifest)
    return records.map((record) => toWire(record, byService.get(record.serviceId) ?? []))
  }

  /** Register a service at a tier. */
  async create(
    ownerKind: FoundationalServiceOwnerKind,
    ownerId: string,
    input: CreateFoundationalServiceInput,
  ): Promise<FoundationalService> {
    const existing = await this.deps.foundationalServiceRepository.get(ownerKind, ownerId, input.id)
    // A LIVE row is a conflict; a tombstoned one is revived by this write. Refusing the
    // revival would leave an id permanently unusable after one delete.
    if (existing && !existing.deletedAt) {
      throw new ConflictError(
        `Foundational service '${input.id}' already exists at this scope`,
        'foundational_service_exists',
        { serviceId: input.id },
      )
    }
    const now = this.deps.clock.now()
    const record: FoundationalServiceRecord = {
      serviceId: input.id,
      ownerKind,
      ownerId,
      name: input.name,
      summary: input.summary,
      description: input.description,
      capabilities: input.capabilities ?? [],
      sourceId: null,
      sourcePath: null,
      pinnedCommit: null,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
      deletedAt: null,
    }
    await this.deps.foundationalServiceRepository.upsert(record)
    const contracts = this.buildUploadedContracts(
      ownerKind,
      ownerId,
      input.id,
      input.contracts,
      now,
    )
    await this.deps.apiContractRepository.replaceForService(ownerKind, ownerId, input.id, contracts)
    await this.invalidate(ownerKind, ownerId)
    return toWire(record, contracts.map(manifestOf))
  }

  /** Patch a registered service. `contracts`, when present, replaces the whole set. */
  async update(
    ownerKind: FoundationalServiceOwnerKind,
    ownerId: string,
    serviceId: string,
    input: UpdateFoundationalServiceInput,
  ): Promise<FoundationalService> {
    const existing = await this.require(ownerKind, ownerId, serviceId)
    const now = this.deps.clock.now()
    const record: FoundationalServiceRecord = {
      ...existing,
      name: input.name ?? existing.name,
      summary: input.summary ?? existing.summary,
      description: input.description ?? existing.description,
      capabilities: input.capabilities ?? existing.capabilities,
      updatedAt: now,
    }
    await this.deps.foundationalServiceRepository.upsert(record)
    let manifest: ApiContractManifestEntry[]
    if (input.contracts) {
      const contracts = this.buildUploadedContracts(
        ownerKind,
        ownerId,
        serviceId,
        input.contracts,
        now,
      )
      await this.deps.apiContractRepository.replaceForService(
        ownerKind,
        ownerId,
        serviceId,
        contracts,
      )
      manifest = contracts.map(manifestOf)
    } else {
      manifest = (
        await this.deps.apiContractRepository.listManifestByOwner(ownerKind, ownerId)
      ).filter((entry) => entry.serviceId === serviceId)
    }
    await this.invalidate(ownerKind, ownerId)
    return toWire(record, manifest)
  }

  /**
   * Remove a service from a tier: TOMBSTONE the row, drop its contract documents.
   *
   * A tombstone at either tier, deliberately. At the workspace tier it is load-bearing — it is
   * also how a board suppresses an inherited account service, which needs a row that survives to
   * lose the merge. At the account tier it carries no such meaning, but keeping one shape means
   * the merge has one rule (`deletedAt` ⇒ gone) rather than a tier-dependent one, and re-creating
   * a removed id later revives the row instead of colliding with a hard-deleted primary key.
   *
   * The DOCUMENTS are dropped outright either way: nothing reads the contracts of a service that
   * is not in the catalog, and they are the only part of this that is measured in megabytes.
   */
  async remove(
    ownerKind: FoundationalServiceOwnerKind,
    ownerId: string,
    serviceId: string,
  ): Promise<void> {
    const now = this.deps.clock.now()
    await this.deps.foundationalServiceRepository.softDelete(ownerKind, ownerId, serviceId, now)
    await this.deps.apiContractRepository.deleteForService(ownerKind, ownerId, serviceId)
    await this.invalidate(ownerKind, ownerId)
  }

  /**
   * Suppress an ACCOUNT service for one workspace by writing a workspace-tier tombstone. The
   * row carries no content of its own — it exists only to lose the merge — so it is written
   * here rather than through {@link create}, which would demand a name and summary for
   * something that is never rendered.
   */
  async suppressForWorkspace(workspaceId: string, serviceId: string): Promise<void> {
    const now = this.deps.clock.now()
    await this.deps.foundationalServiceRepository.upsert({
      serviceId,
      ownerKind: 'workspace',
      ownerId: workspaceId,
      name: '',
      summary: '',
      description: '',
      capabilities: [],
      sourceId: null,
      sourcePath: null,
      pinnedCommit: null,
      createdAt: now,
      updatedAt: now,
      deletedAt: now,
    })
    await this.invalidate('workspace', workspaceId)
  }

  /** The merged catalog a workspace's agents see, cached per workspace. */
  async resolve(workspaceId: string): Promise<ResolvedFoundationalService[]> {
    if (!this.deps.catalogCache) return this.loadCatalog(workspaceId)
    return this.deps.catalogCache.get(workspaceId, workspaceId, () => this.loadCatalog(workspaceId))
  }

  /**
   * The LAZY contract read: full documents for the named services, resolved against the same
   * account ⊕ workspace precedence the catalog uses. One batched query per tier — never a
   * per-service read — and an empty `serviceIds` returns `[]` without touching the store.
   *
   * Precedence matters here as much as in the catalog: a workspace that overrode a service
   * must hand out ITS documents, or the design would be reviewed against the org's spec while
   * the code is written against the board's.
   */
  async contractsFor(
    workspaceId: string,
    serviceIds: string[],
  ): Promise<Map<string, ApiContractDocument[]>> {
    const wanted = [...new Set(serviceIds)].filter(Boolean)
    if (wanted.length === 0) return new Map()
    const accountId = await this.deps.workspaceRepository.accountOf(workspaceId)
    const [workspaceDocs, accountDocs] = await Promise.all([
      this.deps.apiContractRepository.listByServiceIds('workspace', workspaceId, wanted),
      accountId
        ? this.deps.apiContractRepository.listByServiceIds('account', accountId, wanted)
        : Promise.resolve<ApiContractRecord[]>([]),
    ])
    // Which TIER won for each id is decided by the catalog merge, not by which tier happens to
    // hold documents: a workspace row that overrides an account one but ships no contract of
    // its own must NOT silently inherit the account's documents, or the override reads as
    // partially applied. So resolve the winning tier first, then take that tier's documents.
    const catalog = await this.resolve(workspaceId)
    const tierById = new Map(catalog.map((entry) => [entry.id, entry.tier]))
    const out = new Map<string, ApiContractDocument[]>()
    for (const id of wanted) {
      const tier = tierById.get(id)
      if (!tier) continue
      const docs = (tier === 'workspace' ? workspaceDocs : accountDocs).filter(
        (doc) => doc.serviceId === id,
      )
      out.set(id, docs.map(documentOf))
    }
    return out
  }

  /** Drop a tier's cached catalog. An account write invalidates every workspace's. */
  async invalidate(ownerKind: FoundationalServiceOwnerKind, ownerId: string): Promise<void> {
    if (!this.deps.catalogCache) return
    // A workspace write affects exactly one group; an account write affects every workspace in
    // the account, and enumerating them would be a read per invalidation — over-invalidation is
    // always safe, so the account path drops everything (the same call `FragmentLibraryService`
    // makes for the same reason).
    if (ownerKind === 'workspace') await this.deps.catalogCache.invalidateGroup(ownerId)
    else await this.deps.catalogCache.invalidateAll()
  }

  private async loadCatalog(workspaceId: string): Promise<ResolvedFoundationalService[]> {
    const accountId = await this.deps.workspaceRepository.accountOf(workspaceId)
    const [workspaceRows, accountRows, workspaceManifest, accountManifest] = await Promise.all([
      this.deps.foundationalServiceRepository.listByOwner('workspace', workspaceId, true),
      accountId
        ? this.deps.foundationalServiceRepository.listByOwner('account', accountId)
        : Promise.resolve<FoundationalServiceRecord[]>([]),
      this.deps.apiContractRepository.listManifestByOwner('workspace', workspaceId),
      accountId
        ? this.deps.apiContractRepository.listManifestByOwner('account', accountId)
        : Promise.resolve<ApiContractManifestEntry[]>([]),
    ])
    return mergeFoundationalTiers({
      accountRows,
      workspaceRows,
      accountManifest: indexManifest(accountManifest),
      workspaceManifest: indexManifest(workspaceManifest),
    })
  }

  private async require(
    ownerKind: FoundationalServiceOwnerKind,
    ownerId: string,
    serviceId: string,
  ): Promise<FoundationalServiceRecord> {
    const record = await this.deps.foundationalServiceRepository.get(ownerKind, ownerId, serviceId)
    if (!record || record.deletedAt) throw new NotFoundError('FoundationalService', serviceId)
    return record
  }

  private buildUploadedContracts(
    ownerKind: FoundationalServiceOwnerKind,
    ownerId: string,
    serviceId: string,
    uploads: CreateFoundationalServiceInput['contracts'],
    now: number,
  ): ApiContractRecord[] {
    const seen = new Set<string>()
    return (uploads ?? []).map((upload) => {
      if (seen.has(upload.contractId)) {
        throw new ValidationError(`Duplicate contract id '${upload.contractId}'`, {
          reason: 'duplicate_contract_id',
          contractId: upload.contractId,
        })
      }
      seen.add(upload.contractId)
      validateUploadedContract(upload)
      const summary = summarizeContract({
        contractId: upload.contractId,
        format: upload.format,
        title: upload.title,
        path: null,
        body: upload.body,
      })
      return {
        ownerKind,
        ownerId,
        serviceId,
        contractId: upload.contractId,
        format: upload.format,
        title: upload.title,
        body: upload.body,
        operations: summary.operations,
        omittedOperations: summary.omittedOperations,
        sourcePath: null,
        sourceSha: null,
        createdAt: now,
        updatedAt: now,
      }
    })
  }
}

function indexManifest(
  entries: ApiContractManifestEntry[],
): Map<string, ApiContractManifestEntry[]> {
  const map = new Map<string, ApiContractManifestEntry[]>()
  for (const entry of entries) {
    const list = map.get(entry.serviceId)
    if (list) list.push(entry)
    else map.set(entry.serviceId, [entry])
  }
  return map
}

/**
 * A just-written contract record → its manifest entry. The operation index is recomputed from
 * the body here rather than read back, so a create/update response describes exactly what was
 * stored without a second round trip.
 */
function manifestOf(record: ApiContractRecord): ApiContractManifestEntry {
  return {
    serviceId: record.serviceId,
    contractId: record.contractId,
    format: record.format,
    title: record.title,
    // `documentSize`, never `body.length` — the listing path derives this in SQL and the two
    // must agree for the same row (see the helper's note).
    size: documentSize(record.body),
    operations: record.operations,
    omittedOperations: record.omittedOperations,
    sourcePath: record.sourcePath,
  }
}

/**
 * A stored record → the wire document. The operation index is read off the ROW rather than
 * recomputed: it is the same index the catalog showed, so a consumer can never see a document
 * whose operation list disagrees with the one the design was chosen from.
 */
function documentOf(record: ApiContractRecord): ApiContractDocument {
  return {
    contractId: record.contractId,
    format: record.format,
    title: record.title,
    size: documentSize(record.body),
    path: record.sourcePath,
    operations: record.operations,
    omittedOperations: record.omittedOperations,
    body: record.body,
  }
}
