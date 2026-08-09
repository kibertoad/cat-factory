import { Hono } from 'hono'
import { verifyMachineRequest } from '../../auth/machineGate.js'
import type { AppEnv } from '../../http/env.js'
import {
  type LibrarySourceEntity,
  type LibrarySourceOwnerLookup,
  type PersistenceRegistry,
  type PersistenceRpcRequest,
  dispatchPersistenceCall,
} from '../../persistence/rpc.js'

/**
 * The mothership-mode machine API: `POST /internal/persistence`.
 *
 * A mothership-mode local node has no main database — it forwards every org/durable
 * repository call here, to the hosted mothership, over this ONE reflective endpoint. The
 * mothership reflects over its real repository registry (`container.repositories`, attached
 * by each facade) and returns the result.
 *
 * Security: this endpoint is gated NOT by the user-session `authGate` (its prefix `/internal`
 * is in that gate's bypass list) but by its own machine-token check here — a token minted by
 * the mothership for a whitelisted node, audience-pinned `machine` so a user session / ws
 * ticket / container token can never be replayed against raw persistence. Every call is then
 * account-scoped to the token (`dispatchPersistenceCall`): a method outside the per-repo
 * allow-list is refused, and a call resolving to an account outside the token's scope is a
 * 404 (matching the auth gate's existence-non-leak policy).
 *
 * Mounted on BOTH facades via the shared controller registration, so either a Node or a
 * Cloudflare deployment can be a mothership. A facade that does not attach `repositories`
 * (every deployment that isn't acting as a mothership) serves a 503 here.
 */
export function persistenceController(): Hono<AppEnv> {
  const app = new Hono<AppEnv>()

  app.post('/internal/persistence', async (c) => {
    const container = c.get('container')
    const registry = container.repositories
    if (!registry) {
      return c.json(
        { ok: false, error: { code: 'internal', message: 'persistence RPC not enabled' } },
        503,
      )
    }

    // The shared machine gate: audience-pinned verify + the revoked-node roster check.
    const payload = await verifyMachineRequest(c)
    if (!payload) {
      return c.json(
        { ok: false, error: { code: 'forbidden', message: 'invalid machine token' } },
        403,
      )
    }

    let request: PersistenceRpcRequest
    try {
      request = (await c.req.json()) as PersistenceRpcRequest
    } catch {
      return c.json(
        { ok: false, error: { code: 'validation', message: 'invalid request body' } },
        422,
      )
    }
    if (!request || typeof request.repo !== 'string' || typeof request.method !== 'string') {
      return c.json(
        { ok: false, error: { code: 'validation', message: 'repo and method are required' } },
        422,
      )
    }

    const workspaceRepository = registry.workspaceRepository
    const blockRepository = registry.blockRepository
    const serviceRepository = registry.serviceRepository
    const skillSourceRepository = registry.skillSourceRepository
    // The owner-pair content-library source tables, keyed by the `LibrarySourceEntity` the rule
    // names, so one resolver answers for both (and a new library is one row here). Keyed by the
    // UNION rather than by `string`: a member added to `LibrarySourceEntity` must fail to compile
    // here rather than resolve to nothing, which the stored-half check would otherwise be entitled
    // to read as "no such row" and admit.
    const librarySourceRepos: Record<LibrarySourceEntity, PersistenceRegistry[string] | undefined> =
      {
        fragmentSource: registry.fragmentSourceRepository,
        foundationalServiceSource: registry.foundationalServiceSourceRepository,
      }
    const resolveAccountId = (workspaceId: string) =>
      (workspaceRepository?.accountOf?.(workspaceId) as Promise<string | null | undefined>) ??
      Promise.resolve(undefined)

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
    const blockFindById = memoizeRead((blockId) => blockRepository?.findById?.(blockId as string))
    const blockFindByIds = memoizeRead((ids) => blockRepository?.findByIds?.(ids as string[]))
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
      // The `skillSource` scope resolves a source's account by reading the source; when the
      // dispatched call IS that read (the sync service's `get`), reuse the resolver's result.
      'skillSourceRepository.get': { skillSourceRepository: { get: skillSourceGet } },
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

    const result = await dispatchPersistenceCall(request, {
      registry: registryForDispatch,
      scope: { accountIds: payload.scope.accountIds, userId: payload.userId },
      resolveAccountId,
      // A block is keyed only by its id; resolve its home workspace, then that workspace's account.
      resolveBlockAccountId: async (blockId) => {
        const found = (await blockFindById(blockId)) as { workspaceId?: string } | null | undefined
        const workspaceId = found?.workspaceId
        return typeof workspaceId === 'string' ? resolveAccountId(workspaceId) : undefined
      },
      // The batched form: one findByIds resolves every block's home workspace, then each
      // (deduped) workspace's account. A block absent from the read is absent from the map.
      resolveBlockAccountIds: async (blockIds) => {
        const found = (await blockFindByIds(blockIds)) as
          | Array<{ workspaceId: string; block: { id: string } }>
          | undefined
        const accountByWorkspace = memoizeRead((workspaceId) =>
          resolveAccountId(workspaceId as string),
        )
        const map = new Map<string, string | null | undefined>()
        for (const entry of found ?? []) {
          map.set(
            entry.block.id,
            (await accountByWorkspace(entry.workspaceId)) as string | null | undefined,
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
      // The member-display scope (`user`/`userList`): a userId is in scope iff a co-member of an
      // in-scope account, so resolve each in-scope account's roster to userIds. Bounded by the
      // token's account scope, not the requested user list.
      resolveAccountMemberIds: async (accountId) => {
        const memberships = (await registry.membershipRepository?.listByAccount?.(accountId)) as
          | Array<{ userId: string }>
          | undefined
        return (memberships ?? []).map((m) => m.userId)
      },
    })
    return c.json(result.body, result.status as 200 | 400 | 403 | 404 | 409 | 422 | 428 | 500)
  })

  return app
}
