import type {
  DispatchOptions,
  EntityOwnerLookup,
  LibrarySourceEntity,
  LibrarySourceOwnerLookup,
  PersistenceRegistry,
  PersistenceRpcRequest,
} from '../../persistence/rpc.js'

/**
 * The per-request READ MEMO, plus the one registry substitution it earns.
 *
 * Every entity-keyed scope rule resolves a row to bind the call, and for a handful of methods that
 * row IS what the call then dispatches. Memoising each read per request keeps those to one query,
 * and the `memoOverrides` table points the dispatched method at the same memo. Extracted from
 * {@link buildDispatchScope} when the batched resolvers pushed it past its function-size budget:
 * this half is about READING ONCE, the other about what a read MEANS for scope.
 */
function buildRequestReaders(registry: PersistenceRegistry, request: PersistenceRpcRequest) {
  const workspaceRepository = registry.workspaceRepository
  const blockRepository = registry.blockRepository
  const serviceRepository = registry.serviceRepository
  const skillSourceRepository = registry.skillSourceRepository
  // The owner-pair content-library source tables, keyed by the `LibrarySourceEntity` the rule
  // names, so one resolver answers for both (and a new library is one row here). Keyed by the
  // UNION rather than by `string`: a member added to `LibrarySourceEntity` must fail to compile
  // here rather than resolve to nothing, which the stored-half check would otherwise be entitled
  // to read as "no such row" and admit.
  const librarySourceRepos: Record<LibrarySourceEntity, PersistenceRegistry[string] | undefined> = {
    fragmentSource: registry.fragmentSourceRepository,
    foundationalServiceSource: registry.foundationalServiceSourceRepository,
  }
  const resolveAccountId = (workspaceId: string) =>
    (workspaceRepository?.accountOf?.(workspaceId) as Promise<string | null | undefined>) ??
    Promise.resolve(undefined)
  // The BATCHED account read every list-shaped rule binds through. A registry that does not wire
  // it answers an empty map, which fails every id closed rather than admitting one: the same
  // disposition an unresolvable `accountOf` already has.
  const readAccountIds = async (workspaceIds: string[]): Promise<Record<string, string | null>> =>
    ((await workspaceRepository?.accountIdsOf?.(workspaceIds)) as
      | Record<string, string | null>
      | undefined) ?? {}

  // The `block`/`serviceList`/`service` scope checks resolve the owning account by reading the
  // entity (`blockRepository.findById` / `serviceRepository.listByIds`). When the request ALSO
  // dispatches that same read, memoise it per request so the resolver's read is reused instead
  // of issuing a second identical query. `serviceRepository.get(id)` is the single-service form:
  // its `service` scope resolves via `listByIds([id])`, so the dispatched `get` is routed through
  // the same memo (a single-id `listByIds` yields the same row) rather than a second point read.
  // (For every other `serviceList` method the dispatched method differs from the resolver's read,
  // so there is nothing to dedupe.)
  const memoizeRead = (fn: (...args: unknown[]) => unknown) => {
    const cache = new Map<string, Promise<unknown>>()
    return (...args: unknown[]): Promise<unknown> => {
      const key = JSON.stringify(args)
      const hit = cache.get(key)
      if (hit) return hit
      const pending = Promise.resolve(fn(...args))
      cache.set(key, pending)
      return pending
    }
  }
  const installationRepository = registry.githubInstallationRepository
  const blockFindById = memoizeRead((blockId) => blockRepository?.findById?.(blockId as string))
  // One memo per installation id, shared by the resolver and (via the override below) the
  // dispatched point read, exactly as the source tables do. Built only when the repository is
  // wired, so an unwired one answers `unreadable` rather than the absence an id-keyed upsert
  // would be entitled to read as a create.
  const installationGet =
    typeof installationRepository?.getByInstallationId === 'function'
      ? memoizeRead((id) => installationRepository.getByInstallationId!(id as number))
      : undefined
  const blockFindByIds = memoizeRead((ids) => blockRepository?.findByIds?.(ids as string[]))
  // One memo per requested SET of workspace ids, shared by the resolver and (via the override
  // below) the dispatched `accountIdsOf`, exactly as the other self-keyed reads do.
  const accountIdsOf = memoizeRead((ids) => readAccountIds(ids as string[]))
  const installationListByIds = memoizeRead((ids) =>
    installationRepository?.listByInstallationIds?.(ids as number[]),
  )
  const serviceListByIds = memoizeRead((ids) => serviceRepository?.listByIds?.(ids as string[]))
  const skillSourceGet = memoizeRead((id) => skillSourceRepository?.get?.(id as string))
  // One memo per source TABLE, keyed by entity: the resolver and the dispatched `get` of the same
  // library then share a read, exactly as `skillSourceGet` does for skills. A table whose `get`
  // this deployment does not wire gets NO reader rather than one answering `undefined`, so the
  // resolver below can report `unreadable` instead of the absence that would admit an upsert.
  const librarySourceReader = (entity: LibrarySourceEntity) => {
    const repo = librarySourceRepos[entity]
    if (typeof repo?.get !== 'function') return undefined
    // Called through the repository so a class-implemented `get` keeps its receiver.
    return memoizeRead((id) => repo.get!(id as string))
  }
  const librarySourceGets: Record<
    LibrarySourceEntity,
    ((id: unknown) => Promise<unknown>) | undefined
  > = {
    fragmentSource: librarySourceReader('fragmentSource'),
    foundationalServiceSource: librarySourceReader('foundationalServiceSource'),
  }
  // For the self-keyed reads, point the dispatcher's own call at the memo so it hits the
  // resolver's already-resolved result. Only the one dispatched method is overridden; the rest
  // of the registry is untouched. Keyed `repo.method` so a new self-keyed read is one row here
  // rather than another rung on a ternary chain.
  const serviceGetViaMemo = async (id: unknown) =>
    ((await serviceListByIds([id])) as Array<{ id: string }> | undefined)?.[0] ?? null
  const memoOverrides: Record<string, PersistenceRegistry> = {
    'blockRepository.findById': { blockRepository: { findById: blockFindById } },
    'blockRepository.findByIds': { blockRepository: { findByIds: blockFindByIds } },
    'serviceRepository.listByIds': { serviceRepository: { listByIds: serviceListByIds } },
    'serviceRepository.get': { serviceRepository: { get: serviceGetViaMemo } },
    // The two batched self-keyed reads: the `workspaceList` rule resolves the accounts of exactly
    // the ids `accountIdsOf` is being asked for, and `installationList` resolves the owners of
    // exactly the ids `listByInstallationIds` is being asked for.
    'workspaceRepository.accountIdsOf': { workspaceRepository: { accountIdsOf } },
    'githubInstallationRepository.listByInstallationIds': {
      githubInstallationRepository: { listByInstallationIds: installationListByIds },
    },
    // The `skillSource` scope resolves a source's account by reading the source; when the
    // dispatched call IS that read (the sync service's `get`), reuse the resolver's result.
    'skillSourceRepository.get': { skillSourceRepository: { get: skillSourceGet } },
    // The same self-keyed read for an installation: the `installation` rule resolves the row to
    // scope the call, and the dispatched `getByInstallationId` IS that row.
    ...(installationGet
      ? {
          'githubInstallationRepository.getByInstallationId': {
            githubInstallationRepository: { getByInstallationId: installationGet },
          },
        }
      : {}),
    // The same self-keyed read for the two owner-pair libraries' source tables. Contributed only
    // where a reader exists: a table whose `get` is unwired has nothing to memoise, and the
    // dispatcher's own wiring check answers that call with `... is not wired` regardless.
    ...(librarySourceGets.fragmentSource
      ? {
          'fragmentSourceRepository.get': {
            fragmentSourceRepository: { get: librarySourceGets.fragmentSource },
          },
        }
      : {}),
    ...(librarySourceGets.foundationalServiceSource
      ? {
          'foundationalServiceSourceRepository.get': {
            foundationalServiceSourceRepository: {
              get: librarySourceGets.foundationalServiceSource,
            },
          },
        }
      : {}),
  }
  // Substitute ONLY for a method the real registry actually wires. `memoizeRead` returns a
  // function unconditionally — it closes over an optional-chained call — so overriding an ABSENT
  // repository would satisfy the dispatcher's `typeof fn !== 'function'` wiring check and answer a
  // misconfigured deployment with a scope 404 (or a bare null) instead of the `... is not wired`
  // that names what to fix. The key is only ever consulted after `Object.hasOwn`, so an
  // attacker-controlled `request.repo` cannot reach an inherited member through the lookup below.
  const memoKey = `${request.repo}.${request.method}`
  const override = Object.hasOwn(memoOverrides, memoKey)
    ? typeof registry[request.repo]?.[request.method] === 'function'
      ? memoOverrides[memoKey]
      : undefined
    : undefined
  const registryForDispatch = override ? { ...registry, ...override } : registry

  return {
    registryForDispatch,
    blockRepository,
    installationRepository,
    resolveAccountId,
    accountIdsOf,
    blockFindById,
    blockFindByIds,
    serviceListByIds,
    skillSourceGet,
    librarySourceGets,
    installationGet,
    installationListByIds,
  }
}

/**
 * The per-request SCOPE RESOLUTION half of `POST /internal/persistence`: the entity readers the
 * dispatcher binds a call through (block → workspace → account, service → account, a library
 * source's owner pair, an installation's owner, an account's roster), over the per-request memo
 * {@link buildRequestReaders} builds.
 *
 * Split out of `PersistenceController` when the surface completion pushed the handler past its
 * function-size budget. It is the half that grows: every new entity-keyed scope rule adds a
 * resolver here, while the controller's own job (gate, parse, dispatch, relay) does not change.
 */
export function buildDispatchScope(
  registry: PersistenceRegistry,
  request: PersistenceRpcRequest,
  scope: { accountIds: string[]; userId: string },
): DispatchOptions {
  const {
    registryForDispatch,
    blockRepository,
    installationRepository,
    resolveAccountId,
    accountIdsOf,
    blockFindById,
    blockFindByIds,
    serviceListByIds,
    skillSourceGet,
    librarySourceGets,
    installationGet,
    installationListByIds,
  } = buildRequestReaders(registry, request)

  return {
    registry: registryForDispatch,
    scope,
    resolveAccountId,
    resolveAccountIds: async (workspaceIds) => {
      const accounts = (await accountIdsOf(workspaceIds)) as Record<string, string | null>
      return new Map(Object.entries(accounts))
    },
    // A block is keyed only by its id; resolve its home workspace, then that workspace's account.
    resolveBlockAccountId: async (blockId) => {
      const found = (await blockFindById(blockId)) as { workspaceId?: string } | null | undefined
      const workspaceId = found?.workspaceId
      return typeof workspaceId === 'string' ? resolveAccountId(workspaceId) : undefined
    },
    // The batched form, in exactly two reads however long the list: one `findByIds` resolves every
    // block's home workspace, then ONE `accountIdsOf` over the deduped workspaces. A block absent
    // from either read is absent from the map.
    resolveBlockAccountIds: async (blockIds) => {
      const found = (await blockFindByIds(blockIds)) as
        | Array<{ workspaceId: string; block: { id: string } }>
        | undefined
      const entries = found ?? []
      const accounts = (await accountIdsOf([
        ...new Set(entries.map((entry) => entry.workspaceId)),
      ])) as Record<string, string | null>
      const map = new Map<string, string | null | undefined>()
      for (const entry of entries) {
        map.set(
          entry.block.id,
          Object.hasOwn(accounts, entry.workspaceId) ? accounts[entry.workspaceId] : undefined,
        )
      }
      return map
    },
    // Services are account-owned; resolve each requested id's `accountId` for the scope check.
    resolveServiceAccountIds: async (serviceIds) => {
      const services = (await serviceListByIds(serviceIds)) as
        | Array<{ id: string; accountId: string | null }>
        | undefined
      const map = new Map<string, string | null | undefined>()
      for (const service of services ?? []) map.set(service.id, service.accountId)
      return map
    },
    // Skill sources are account-owned; the sync surface's methods carry only a source id, so
    // resolve the row and project its `accountId` for the scope check. A source that does not
    // exist resolves to undefined, which fails closed (404) exactly like a missing block/service.
    resolveSkillSourceAccountId: async (sourceId) => {
      const source = (await skillSourceGet(sourceId)) as { accountId?: string } | null | undefined
      return source?.accountId
    },
    // The owner-PAIR libraries' equivalent: a fragment / foundational-service source is owned by
    // an `(ownerKind, ownerId)` tier rather than an account, so project the pair and let the rule
    // resolve it the way it resolves a positional owner. A source that does not exist answers
    // `absent`, which the sourceId-keyed rules fail closed on (404) exactly like a missing
    // block/service, and which `ownerFieldUpsert` alone reads as a create.
    resolveLibrarySourceOwner: async (entity, sourceId): Promise<LibrarySourceOwnerLookup> => {
      const read = librarySourceGets[entity]
      // No reader for that table: nothing is known about the id, so say so. Answering `absent`
      // here would let an id-keyed upsert through on its DECLARED owner alone.
      if (!read) return { status: 'unreadable' }
      const source = (await read(sourceId)) as
        | { ownerKind?: unknown; ownerId?: unknown }
        | null
        | undefined
      return source
        ? { status: 'found', owner: { ownerKind: source.ownerKind, ownerId: source.ownerId } }
        : { status: 'absent' }
    },
    // A VCS installation binds either an ACCOUNT (a GitHub App installation, shared with every
    // board of that account) or just its connector WORKSPACE (a per-workspace PAT, which stores
    // no account). Resolve the effective owner so both bind the same way, and keep "no such
    // binding" apart from "this deployment cannot read the table": the batched annotation read
    // admits the first and must refuse the second.
    resolveInstallationOwner: async (installationId): Promise<EntityOwnerLookup> => {
      if (!installationGet) return { status: 'unreadable' }
      const row = (await installationGet(installationId)) as
        | { accountId?: string | null; workspaceId?: string }
        | null
        | undefined
      if (!row) return { status: 'absent' }
      if (typeof row.accountId === 'string') return { status: 'found', accountId: row.accountId }
      const workspaceId = row.workspaceId
      return {
        status: 'found',
        accountId: typeof workspaceId === 'string' ? await resolveAccountId(workspaceId) : null,
      }
    },
    // The batched form: one `listByInstallationIds` plus one `accountIdsOf` over the connector
    // workspaces of the PAT bindings that store no account. Ids with no binding are absent from
    // the read, so the rule sees them as `absent` (the admission the annotation read needs) while
    // an UNWIRED repository yields no map at all, which the rule fails closed on.
    resolveInstallationOwners: async (installationIds) => {
      const owners = new Map<number, EntityOwnerLookup>()
      if (typeof installationRepository?.listByInstallationIds !== 'function') {
        for (const id of installationIds) owners.set(id, { status: 'unreadable' })
        return owners
      }
      const rows = ((await installationListByIds(installationIds)) ?? []) as Array<{
        installationId: number
        accountId?: string | null
        workspaceId?: string
      }>
      const patWorkspaces = rows
        .filter((row) => typeof row.accountId !== 'string' && typeof row.workspaceId === 'string')
        .map((row) => row.workspaceId as string)
      const accounts = (await accountIdsOf([...new Set(patWorkspaces)])) as Record<
        string,
        string | null
      >
      for (const row of rows) {
        if (typeof row.accountId === 'string') {
          owners.set(row.installationId, { status: 'found', accountId: row.accountId })
          continue
        }
        const workspaceId = row.workspaceId
        owners.set(row.installationId, {
          status: 'found',
          accountId:
            typeof workspaceId === 'string' && Object.hasOwn(accounts, workspaceId)
              ? accounts[workspaceId]
              : null,
        })
      }
      for (const id of installationIds) {
        if (!owners.has(id)) owners.set(id, { status: 'absent' })
      }
      return owners
    },
    // A service's frame block, as the three states `serviceInsert` needs: the row is written
    // BEFORE its block, so `absent` is the ordinary create and only `found` binds.
    resolveFrameBlockOwner: async (frameBlockId): Promise<EntityOwnerLookup> => {
      if (typeof blockRepository?.findById !== 'function') return { status: 'unreadable' }
      const found = (await blockFindById(frameBlockId)) as { workspaceId?: string } | null
      if (!found) return { status: 'absent' }
      const workspaceId = found.workspaceId
      return {
        status: 'found',
        accountId: typeof workspaceId === 'string' ? await resolveAccountId(workspaceId) : null,
      }
    },
    // The member-display scope (`user`/`userList`): a userId is in scope iff a co-member of an
    // in-scope account, so resolve each in-scope account's roster to userIds. Bounded by the
    // token's account scope, not the requested user list.
    resolveAccountMemberIds: async (accountId) => {
      const memberships = (await registry.membershipRepository?.listByAccount?.(accountId)) as
        | Array<{ userId: string }>
        | undefined
      return (memberships ?? []).map((m) => m.userId)
    },
  }
}
