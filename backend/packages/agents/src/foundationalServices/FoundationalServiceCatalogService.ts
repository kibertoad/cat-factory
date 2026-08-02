import type {
  ApiContractDocument,
  CreateFoundationalServiceInput,
  FoundationalService,
  FoundationalServiceOwnerKind,
  FoundationalServiceSuppression,
  ResolvedFoundationalService,
  UpdateFoundationalServiceInput,
} from '@cat-factory/contracts'
import type {
  ApiContractManifestEntry,
  ApiContractRecord,
  ApiContractRepository,
  Clock,
  FoundationalBuiltinSource,
  FoundationalServiceRecord,
  FoundationalServiceRepository,
  GroupCacheHandle,
  WorkspaceRepository,
} from '@cat-factory/kernel'
import {
  ConflictError,
  NotFoundError,
  defaultFoundationalServiceRegistry,
  registryBuiltinSource,
  summarizeContract,
} from '@cat-factory/kernel'
import { mergeFoundationalTiers, toWire } from './foundational-catalog.js'
import { assertValidDefinition } from './contract-validation.js'

export interface FoundationalServiceCatalogDependencies {
  foundationalServiceRepository: FoundationalServiceRepository
  apiContractRepository: ApiContractRepository
  workspaceRepository: WorkspaceRepository
  clock: Clock
  /** The merged per-workspace catalog cache. Absent (tests) ⇒ every resolve reads through. */
  catalogCache?: GroupCacheHandle<ResolvedFoundationalService[]>
  /**
   * The deployment's own registered services — the `builtin` tier. Optional and defaulted to an
   * empty registry, so a construction site that omits it resolves the stored tiers exactly as
   * before.
   *
   * A standalone facade passes its own registry wrapped in `registryBuiltinSource`; a
   * MOTHERSHIP-MODE node passes the remote source, because the estate is org state the
   * mothership owns and a node's own copy could only ever be a second, drifting one. See
   * `kernel/src/ports/foundational-builtins.ts`.
   */
  builtins?: FoundationalBuiltinSource
}

/**
 * The foundational-services catalog (backend/docs/adr/0031-foundational-services.md): per-tier CRUD
 * plus the merged builtin ⊕ account ⊕ workspace resolve every design dispatch reads.
 *
 * Three properties are load-bearing and are why this is a service rather than a repository call:
 *
 * - **The catalog never carries a contract BODY.** `listTier` and `resolve` join the contract
 *   MANIFEST (id, format, title, byte size, operation names) onto each service in ONE extra
 *   query for the whole tier. The documents are read only by {@link contractsFor}, and only for
 *   the ids a caller asks for.
 * - **A later tier wins by id, and a TOMBSTONE at either stored tier suppresses what it
 *   inherits.** That is what lets a board opt out of an org-wide service without an account
 *   admin — and an account out of a deployment `builtin` — and it is why the merge reads both
 *   stored tiers `includeDeleted`.
 * - **The `builtin` tier has no rows.** It is read from the {@link FoundationalBuiltinSource} on
 *   every resolve — the app-owned registry in a standalone deployment, the MOTHERSHIP's own
 *   registry over the machine API on a mothership-mode node — so a deployment's catalog is
 *   present from a workspace's first request and cannot drift from the code that declares it.
 */
export class FoundationalServiceCatalogService {
  /** The deployment's registered services; an empty registry when a facade wired none. */
  private readonly builtins: FoundationalBuiltinSource

  constructor(private readonly deps: FoundationalServiceCatalogDependencies) {
    this.builtins = deps.builtins ?? registryBuiltinSource(defaultFoundationalServiceRegistry())
  }

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
    assertValidDefinition(input)
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
    assertValidDefinition(input)
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
   * Remove a service from a tier. A WORKSPACE removal writes a tombstone (which is also how a
   * board suppresses an inherited account service); an ACCOUNT removal drops the row and its
   * documents outright, since there is no higher tier for it to shadow.
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
   * Suppress an INHERITED service at one tier by writing a tombstone there: an account service
   * for a board, a deployment `builtin` for either. The row carries no content of its own — it
   * exists only to lose the merge — so it is written here rather than through {@link create},
   * which would demand a name and summary for something that is never rendered.
   *
   * Both scopes are served because both now inherit. Leaving it workspace-only once the
   * deployment tier existed would make a registered service un-opt-out-able for a whole account
   * that has one board too many to do it per board.
   *
   * Both refusals are deliberate. An id the merged catalog does not carry would tombstone
   * NOTHING today and silently swallow whatever a lower tier registers under it tomorrow — a
   * suppression nobody could later explain. An id this tier owns a row for is not inherited at
   * all: tombstoning it there would read as a delete while destroying the authored description
   * and contracts, which is {@link remove}'s job and not this one's.
   */
  async suppress(
    ownerKind: FoundationalServiceOwnerKind,
    ownerId: string,
    serviceId: string,
  ): Promise<void> {
    const existing = await this.deps.foundationalServiceRepository.get(
      ownerKind,
      ownerId,
      serviceId,
    )
    // Already suppressed: the tombstone IS the whole state, so a retried request has nothing
    // left to do. Returning rather than 404-ing keeps the endpoint safe to retry, and the merge
    // below could not answer this case anyway — a suppressed id is exactly one the merged
    // catalog no longer carries.
    if (existing?.deletedAt) return
    // Deliberately the uncached merge: both refusals below are decisions ABOUT persisted state,
    // and a TTL'd merge can be behind it. Reading the cache would 404 an opt-out for a service
    // the account registered moments ago, and — worse — write a tombstone against an id the
    // account has since withdrawn, which is exactly the shadows-nothing row the 404 exists to
    // prevent. This is a rare, human-driven write, so the batched reads it costs are not worth
    // trading for a refusal that can be wrong.
    const merged = await this.loadTierView(ownerKind, ownerId)
    const inherited = merged.find((entry) => entry.id === serviceId)
    if (!inherited) throw new NotFoundError('FoundationalService', serviceId)
    if (inherited.tier === ownerKind) {
      throw new ConflictError(
        `Foundational service '${serviceId}' is registered at this scope, not inherited`,
        'foundational_service_not_inherited',
        { serviceId },
      )
    }
    const now = this.deps.clock.now()
    await this.deps.foundationalServiceRepository.upsert({
      serviceId,
      ownerKind,
      ownerId,
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
    await this.invalidate(ownerKind, ownerId)
  }

  /**
   * What a tier is currently suppressing. The merged catalog cannot answer this — a suppressed
   * id is precisely one it no longer carries — so the tombstones are read directly and joined
   * against what this tier inherits for identity.
   *
   * `inherited: false` is the case worth keeping distinct: the tombstone shadows nothing today,
   * because the tier below withdrew the service or because the row is the remains of this tier
   * DELETING its own registration. Collapsing the two would tell an operator a capability is
   * being withheld when there is none to withhold.
   */
  async listSuppressions(
    ownerKind: FoundationalServiceOwnerKind,
    ownerId: string,
  ): Promise<FoundationalServiceSuppression[]> {
    const rows = await this.deps.foundationalServiceRepository.listByOwner(ownerKind, ownerId, true)
    const tombstones = rows.filter((row) => row.deletedAt !== null)
    if (tombstones.length === 0) return []
    const inherited = new Map(
      (await this.inheritedIdentities(ownerKind, ownerId)).map((entry) => [entry.id, entry]),
    )
    return tombstones.map((row) => {
      const shadowed = inherited.get(row.serviceId)
      return {
        id: row.serviceId,
        // The inherited entry's identity when there is one; otherwise whatever the tombstone
        // carries, which is empty for a suppression written against an id this tier never
        // registered — the id is then the only honest name, and it is the one an Architect uses.
        name: shadowed?.name ?? row.name,
        summary: shadowed?.summary ?? row.summary,
        inherited: shadowed !== undefined,
      }
    })
  }

  /**
   * The identity of everything a tier INHERITS: the merge as the tier BELOW it resolves it.
   *
   * Deliberately the same {@link loadTierView} the merge and {@link suppress} run on, rather than
   * a second walk over builtins + account rows. Inheritance is a precedence question, and the
   * tombstone half of that precedence is easy to leave out of a hand-rolled second copy — which
   * is exactly what happened: reading the account's LIVE rows beside the registry made a builtin
   * the account had already suppressed still look inherited by every board under it, so a board's
   * own opt-out claimed to be shadowing a service no board could see. `inherited` is the one
   * thing this list has to be right about, since it is the difference between "a capability is
   * being withheld" and "there is none to withhold".
   *
   * The cost is one manifest read whose contracts nothing here uses. That is the correct trade
   * for a rare, human-driven settings read: a second precedence implementation is a standing
   * invitation for the two to disagree again, and only one of them is the one agents resolve.
   */
  private async inheritedIdentities(
    ownerKind: FoundationalServiceOwnerKind,
    ownerId: string,
  ): Promise<{ id: string; name: string; summary: string }[]> {
    // An account's tier below is the deployment's registry and nothing else.
    if (ownerKind === 'account') return this.builtins.entries()
    const accountId = await this.deps.workspaceRepository.accountOf(ownerId)
    // A board with no account inherits the deployment tier directly, with nothing able to
    // suppress it in between.
    if (!accountId) return this.builtins.entries()
    return this.loadTierView('account', accountId)
  }

  /**
   * Undo a suppression: DROP this tier's tombstone so the inherited service is offered again.
   *
   * The row is deleted rather than un-tombstoned because a tombstone carries no name, summary or
   * contracts — clearing its `deletedAt` would revive it as an EMPTY override that wins the
   * merge, which is a worse outcome than the suppression it was meant to undo. It is also why a
   * LIVE row is refused with a 404 rather than deleted: the caller asked to lift a suppression,
   * and this tier is not suppressing anything.
   */
  async restoreInherited(
    ownerKind: FoundationalServiceOwnerKind,
    ownerId: string,
    serviceId: string,
  ): Promise<void> {
    const row = await this.deps.foundationalServiceRepository.get(ownerKind, ownerId, serviceId)
    if (!row || !row.deletedAt) throw new NotFoundError('FoundationalServiceSuppression', serviceId)
    await this.deps.foundationalServiceRepository.hardDelete(ownerKind, ownerId, serviceId)
    await this.invalidate(ownerKind, ownerId)
  }

  /** The merged catalog a workspace's agents see, cached per workspace. */
  async resolve(workspaceId: string): Promise<ResolvedFoundationalService[]> {
    if (!this.deps.catalogCache) return this.loadCatalog(workspaceId)
    return this.deps.catalogCache.get(workspaceId, workspaceId, () => this.loadCatalog(workspaceId))
  }

  /**
   * The LAZY contract read: full documents for the named services, resolved against the same
   * builtin ⊕ account ⊕ workspace precedence the catalog uses. One batched query per stored
   * tier — never a per-service read — and an empty `serviceIds` returns `[]` without touching
   * the store.
   *
   * Precedence matters here as much as in the catalog: a workspace that overrode a service
   * must hand out ITS documents, or the design would be reviewed against the org's spec while
   * the code is written against the board's. A `builtin` winner's documents come from the
   * registry, which is the only place they exist.
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
    // The `builtin` winners in ONE read, before the loop — the tier's source can be remote (a
    // mothership-mode node), where a per-id read inside the loop is an N+1 over the wire. The
    // stored tiers are already batched above for the same reason.
    const builtinIds = wanted.filter((id) => tierById.get(id) === 'builtin')
    const builtinDocs =
      builtinIds.length > 0
        ? await this.builtins.documentsFor(builtinIds)
        : new Map<string, ApiContractDocument[]>()
    const out = new Map<string, ApiContractDocument[]>()
    for (const id of wanted) {
      const tier = tierById.get(id)
      if (!tier) continue
      if (tier === 'builtin') {
        out.set(id, builtinDocs.get(id) ?? [])
        continue
      }
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
        ? this.deps.foundationalServiceRepository.listByOwner('account', accountId, true)
        : Promise.resolve<FoundationalServiceRecord[]>([]),
      this.deps.apiContractRepository.listManifestByOwner('workspace', workspaceId),
      accountId
        ? this.deps.apiContractRepository.listManifestByOwner('account', accountId)
        : Promise.resolve<ApiContractManifestEntry[]>([]),
    ])
    return mergeFoundationalTiers({
      builtins: await this.builtins.entries(),
      accountRows,
      workspaceRows,
      accountManifest: indexManifest(accountManifest),
      workspaceManifest: indexManifest(workspaceManifest),
    })
  }

  /**
   * The merge as ONE tier sees it — what {@link suppress} decides against. For a workspace that
   * is the full catalog; for an account it is the deployment's registered services under its own
   * rows, since an account has exactly one tier below it and no workspace above it to consult.
   */
  private async loadTierView(
    ownerKind: FoundationalServiceOwnerKind,
    ownerId: string,
  ): Promise<ResolvedFoundationalService[]> {
    if (ownerKind === 'workspace') return this.loadCatalog(ownerId)
    const [accountRows, accountManifest] = await Promise.all([
      this.deps.foundationalServiceRepository.listByOwner('account', ownerId, true),
      this.deps.apiContractRepository.listManifestByOwner('account', ownerId),
    ])
    return mergeFoundationalTiers({
      builtins: await this.builtins.entries(),
      accountRows,
      workspaceRows: [],
      accountManifest: indexManifest(accountManifest),
      workspaceManifest: new Map(),
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

  /**
   * Uploaded documents → stored rows. The definition was already refused at the top of the
   * write (`assertValidDefinition`) — validating the SET has to happen before any of it is
   * built, since a set's anchor may be its last document.
   */
  private buildUploadedContracts(
    ownerKind: FoundationalServiceOwnerKind,
    ownerId: string,
    serviceId: string,
    uploads: CreateFoundationalServiceInput['contracts'],
    now: number,
  ): ApiContractRecord[] {
    return (uploads ?? []).map((upload) => {
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
    size: record.body.length,
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
    size: record.body.length,
    path: record.sourcePath,
    operations: record.operations,
    omittedOperations: record.omittedOperations,
    body: record.body,
  }
}
