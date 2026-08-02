import type { ApiContractDocument } from '@cat-factory/contracts'
import type {
  FoundationalServiceRegistry,
  FoundationalServiceRegistryEntry,
} from '../domain/foundational-service-registry.js'

// Where the catalog's `builtin` tier is READ from — one seam behind the two projections the
// merge and the lazy contract read need (ADR 0031). It exists because a deployment is not
// always ONE process.
//
// In a standalone deployment the tier is the in-process `FoundationalServiceRegistry` the
// composition root news, and this port is a thin wrapper over it ({@link registryBuiltinSource}).
//
// In MOTHERSHIP mode (docs/initiatives/mothership-mode.md) a deployment is two processes: the
// hosted mothership answers the SPA's catalog reads, and a local node with no main database
// resolves the catalog for the runs it dispatches. Registering the estate on BOTH is what the
// registry-only shape forced, and the two copies were equal only for as long as both entry
// points imported the same package at the same commit — with nothing detecting a skew, and a
// local node one build behind being the NORMAL state of a mothership deployment. The failure
// was silent in the worst direction: a run whose catalog is missing a service simply does not
// consider it, which reads exactly like an Architect deciding the service was not relevant.
//
// So the estate is org state and the mothership owns it, like every other org fact a
// mothership-mode node reads remotely: the node resolves this port over
// `GET /internal/foundational-services`, and its own in-process registry is not consulted.
// A read failure THROWS rather than answering with an empty tier, because "the mothership is
// unreachable" and "the deployment registers no shared services" need opposite reactions and
// only one of them may reach an Architect's prompt.

/**
 * The `builtin` tier of the foundational-service catalog, as the catalog service reads it.
 *
 * Deliberately just the two projections {@link FoundationalServiceRegistry} already exposes —
 * identity/manifests for the merge, full documents for the lazy read — so a remote
 * implementation is a transport and never a second view of the data. Both are async because one
 * implementation crosses a network; an in-process source resolves immediately.
 */
export interface FoundationalBuiltinSource {
  /** Every registered service, projected for the catalog merge (identity, manifests, no bodies). */
  entries(): Promise<FoundationalServiceRegistryEntry[]>
  /**
   * The FULL contract documents of the named registered services — the lazy read's `builtin`
   * half, indexed by service id. An id the tier does not carry is simply absent from the map.
   *
   * Batched rather than per-id because one implementation crosses a network: the caller always
   * has the whole declared set in hand (`contractsFor`), and a per-id read in a loop over it is
   * the N+1 the stored tiers already avoid with `listByServiceIds`.
   */
  documentsFor(ids: string[]): Promise<Map<string, ApiContractDocument[]>>
}

/**
 * The in-process source: a deployment's own registry, read directly. The default on every
 * facade that is not a mothership-mode node.
 */
export function registryBuiltinSource(
  registry: FoundationalServiceRegistry,
): FoundationalBuiltinSource {
  return {
    entries: async () => registry.entries(),
    documentsFor: async (ids) => new Map(ids.map((id) => [id, registry.documentsFor(id)] as const)),
  }
}
