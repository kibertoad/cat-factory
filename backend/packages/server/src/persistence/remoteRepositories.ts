import {
  type PersistenceRpcRequest,
  type PersistenceRpcResponse,
  persistenceErrorToThrowable,
} from './rpc.js'

// The client side of the mothership-mode persistence RPC: a mothership-mode local node
// builds `Proxy`-backed repositories instead of Drizzle ones, so every repository call the
// engine makes is forwarded to the hosted mothership over `POST /internal/persistence`.
// Each proxy mirrors a kernel repository port exactly; it turns any `repo.method(...args)`
// into one RPC and applies the wire contract: re-throw `DomainError`s, restore a top-level
// `undefined`, and write a mutated `rev` back onto the caller's object (the optimistic-
// concurrency contract `ExecutionRepository.compareAndSwap`/`upsert` depend on).

/** Transport that performs one persistence call and returns the decoded envelope. */
export interface PersistenceRpcClient {
  call(request: PersistenceRpcRequest): Promise<PersistenceRpcResponse>
}

function makeRepoProxy<T extends object>(client: PersistenceRpcClient, repo: string): T {
  return new Proxy(
    {},
    {
      get(_target, method) {
        // Only string method names are RPC-addressable. A non-string access (a symbol such as
        // `Symbol.toPrimitive` during coercion) AND the `then` property (which `await` /
        // `Promise.resolve` probe to decide whether a value is a thenable) MUST read as absent.
        // Otherwise an accidental `await repoProxy` would see a callable `then`, treat the proxy
        // as a thenable, and forward a bogus `{method:'then'}` RPC. Guarding here (the primitive)
        // covers both an awaited registry and an awaited individual repo proxy.
        if (typeof method !== 'string' || method === 'then') return undefined
        return async (...args: unknown[]) => {
          const res = await client.call({ repo, method, args })
          if (!res.ok) throw persistenceErrorToThrowable(res.error)
          // Restore an in-place `rev` bump (e.g. execution upsert/compareAndSwap), so the
          // caller's instance reflects the stored row exactly as a direct repo would.
          if (res.mutated) {
            const target = args[res.mutated.arg] as { rev?: number } | undefined
            if (target) target.rev = res.mutated.rev
          }
          return res.undef ? undefined : res.value
        }
      },
    },
  ) as T
}

/**
 * A drift-proof, full-surface remote repository registry: a top-level `Proxy` that lazily
 * returns a remote method-proxy for ANY `repoName` accessed (`registry.fooRepository.bar(...)`
 * forwards to one RPC). A mothership-mode local node casts this to its full `CoreRepositories`
 * shape, so EVERY org/durable repository is remote with no per-repo wiring — a new kernel
 * repository is automatically remotely-backed (the server-side allow-list still gates which
 * repo+method actually executes; an un-allow-listed call returns `unknown_method`).
 *
 * Credentials are deliberately NOT part of this set — they stay local (the `node:sqlite`
 * store), composed over the top of this registry by the facade. This is the single mechanism
 * a mothership-mode node uses; there is no narrower typed repository set to drift from it.
 */
export function createRemoteRepositoryRegistry(
  client: PersistenceRpcClient,
): Record<string, unknown> {
  const cache = new Map<string, unknown>()
  return new Proxy(
    {},
    {
      get(_target, repoName) {
        // Only string repo names are RPC-addressable; a symbol access (`Symbol.toPrimitive`) or
        // `then` (probed by an accidental `await registry`) is not a repository and reads as
        // absent — so the registry itself is never mistaken for a thenable. (The per-repo
        // `then`/symbol guard in `makeRepoProxy` protects an awaited individual repo proxy too.)
        if (typeof repoName !== 'string' || repoName === 'then') return undefined
        let proxy = cache.get(repoName)
        if (!proxy) {
          proxy = makeRepoProxy(client, repoName)
          cache.set(repoName, proxy)
        }
        return proxy
      },
    },
  )
}

/**
 * A fetch-based {@link PersistenceRpcClient} that posts to the mothership's
 * `POST /internal/persistence`, presenting the node's machine token. The endpoint always
 * returns the wire envelope (even on a 4xx/5xx), so the body is read regardless of status.
 */
export class HttpPersistenceRpcClient implements PersistenceRpcClient {
  constructor(
    private readonly opts: {
      baseUrl: string
      token: string
      fetchImpl?: typeof fetch
    },
  ) {}

  async call(request: PersistenceRpcRequest): Promise<PersistenceRpcResponse> {
    const fetchImpl = this.opts.fetchImpl ?? fetch
    const res = await fetchImpl(`${this.opts.baseUrl.replace(/\/$/, '')}/internal/persistence`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${this.opts.token}`,
      },
      body: JSON.stringify(request),
    })
    const body = (await res.json().catch(() => null)) as PersistenceRpcResponse | null
    if (body && typeof body === 'object' && 'ok' in body) return body
    // A transport-level failure with no envelope (network / proxy error): surface as internal.
    return {
      ok: false,
      error: { code: 'internal', message: `persistence RPC failed (HTTP ${res.status})` },
    }
  }
}
