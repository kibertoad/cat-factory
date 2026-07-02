import { Hono } from 'hono'
import { HmacSigner, type MachinePayload, TOKEN_AUDIENCE } from '../../auth/signing.js'
import type { AppEnv } from '../../http/env.js'
import { type PersistenceRpcRequest, dispatchPersistenceCall } from '../../persistence/rpc.js'

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

    const secret = container.config.auth.sessionSecret
    const token = c.req.header('authorization')?.replace(/^Bearer\s+/i, '')
    const payload = secret
      ? await new HmacSigner(secret).verify<MachinePayload>(token, { aud: TOKEN_AUDIENCE.machine })
      : null
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
    const serviceListByIds = memoizeRead((ids) => serviceRepository?.listByIds?.(ids as string[]))
    // For the two self-keyed reads, point the dispatcher's own call at the memo so it hits the
    // resolver's already-resolved result. Only the one dispatched method is overridden; the rest
    // of the registry is untouched.
    const serviceGetViaMemo = async (id: unknown) =>
      ((await serviceListByIds([id])) as Array<{ id: string }> | undefined)?.[0] ?? null
    const registryForDispatch =
      request.repo === 'blockRepository' && request.method === 'findById'
        ? { ...registry, blockRepository: { findById: blockFindById } }
        : request.repo === 'serviceRepository' && request.method === 'listByIds'
          ? { ...registry, serviceRepository: { listByIds: serviceListByIds } }
          : request.repo === 'serviceRepository' && request.method === 'get'
            ? { ...registry, serviceRepository: { get: serviceGetViaMemo } }
            : registry

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
      // Services are account-owned; resolve each requested id's `accountId` for the scope check.
      resolveServiceAccountIds: async (serviceIds) => {
        const services = (await serviceListByIds(serviceIds)) as
          | Array<{ id: string; accountId: string | null }>
          | undefined
        const map = new Map<string, string | null | undefined>()
        for (const service of services ?? []) map.set(service.id, service.accountId)
        return map
      },
    })
    return c.json(result.body, result.status as 200 | 400 | 403 | 404 | 409 | 422 | 428 | 500)
  })

  return app
}
