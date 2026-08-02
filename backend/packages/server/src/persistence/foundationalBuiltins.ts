import type { ApiContractDocument } from '@cat-factory/contracts'
import type {
  FoundationalBuiltinSource,
  FoundationalServiceRegistryEntry,
} from '@cat-factory/kernel'
import { UnavailableError, describeError } from '@cat-factory/kernel'

// The client half of the mothership-mode `builtin`-tier read (see
// `../modules/foundationalServices/FoundationalBuiltinsController.ts` for why the tier crosses
// the machine API at all). A mothership-mode node resolves the catalog's deployment tier from the
// mothership instead of from its own registry, so the estate has ONE authoritative definition
// however far behind the node's build has drifted.

/**
 * A {@link FoundationalBuiltinSource} backed by the mothership's
 * `GET /internal/foundational-services` (+ `POST .../contracts`), presenting the node's machine
 * token.
 *
 * **A failed read THROWS; it never degrades to an empty tier.** "The mothership is unreachable"
 * and "this deployment registers no shared services" are the same value and opposite facts, and
 * only one of them may reach an Architect: an empty catalog silently produces a design that
 * reinvents a service the org already runs, which is the exact failure ADR 0031 exists to
 * prevent. Throwing surfaces as a failed design dispatch — loud, and the same disposition every
 * other org read on this node already has, since the persistence RPC fails a run the same way.
 *
 * There is no cache here on purpose. `entries()` is called once per miss of the per-workspace
 * catalog cache that already sits in front of it, and `documentsFor` once per DESIGN (it is
 * batched over the declared set) — so the call volume is bounded by that cache, and a second
 * TTL'd copy of a value
 * with no invalidation path (the tier changes only when the mothership is redeployed) would be
 * the homebrew cache the caching seam exists to keep out.
 */
export class HttpFoundationalBuiltinSource implements FoundationalBuiltinSource {
  constructor(
    private readonly opts: {
      baseUrl: string
      /**
       * The machine token to present, as a fixed string OR a provider read PER REQUEST — the
       * same shape `HttpPersistenceRpcClient` takes, so a token cached after boot by the
       * `/local/mothership/connect` login is picked up without a restart.
       */
      token: string | (() => string | null)
      fetchImpl?: typeof fetch
    },
  ) {}

  async entries(): Promise<FoundationalServiceRegistryEntry[]> {
    const body = await this.read<{ entries?: FoundationalServiceRegistryEntry[] }>(
      '/internal/foundational-services',
    )
    return body.entries ?? []
  }

  async documentsFor(ids: string[]): Promise<Map<string, ApiContractDocument[]>> {
    if (ids.length === 0) return new Map()
    const body = await this.read<{ documents?: Record<string, ApiContractDocument[]> }>(
      '/internal/foundational-services/contracts',
      { ids },
    )
    return new Map(Object.entries(body.documents ?? {}))
  }

  private async read<T>(path: string, payload?: unknown): Promise<T> {
    const fetchImpl = this.opts.fetchImpl ?? fetch
    const token = typeof this.opts.token === 'function' ? this.opts.token() : this.opts.token
    const url = `${this.opts.baseUrl.replace(/\/$/, '')}${path}`
    // The batched contract read carries a LIST, so it is a POST — the same reason the
    // persistence RPC is one. Both are reads; neither is cacheable over the machine API.
    const init: RequestInit = payload
      ? {
          method: 'POST',
          headers: {
            authorization: `Bearer ${token ?? ''}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify(payload),
        }
      : { headers: { authorization: `Bearer ${token ?? ''}` } }
    let res: Response
    try {
      res = await fetchImpl(url, init)
    } catch (error) {
      // A transport failure is reported as the outage it is. The message names the tier rather
      // than the URL, which carries no secret here but would be noise in an operator's log.
      throw new UnavailableError(
        'The foundational-service catalog could not be read from the mothership',
        'foundational_builtins_unreachable',
        // Scrubbed through `redactSecrets` — a fetch failure routinely echoes the request URL,
        // which here carries the mothership's address.
        describeError(error),
      )
    }
    if (!res.ok) {
      // Includes the case that matters most: a mothership OLDER than this node, which answers
      // 404 for a route it does not serve. Reading that as "no registered services" is precisely
      // the silent-empty-catalog failure this class refuses to produce.
      throw new UnavailableError(
        'The mothership refused the foundational-service catalog read',
        'foundational_builtins_unreachable',
        { status: res.status },
      )
    }
    const body = (await res.json().catch(() => null)) as T | null
    if (!body || typeof body !== 'object') {
      throw new UnavailableError(
        'The mothership returned an unreadable foundational-service catalog',
        'foundational_builtins_unreachable',
      )
    }
    return body
  }
}
