import type {
  ApiContractDocument,
  ApiContractSummary,
  CreateFoundationalServiceInput,
} from '@cat-factory/contracts'
import { deepFreeze } from '../shared/deep-freeze.logic.js'
import { summarizeContract } from './foundational-services.js'
import { platformAssetStorageService } from './platform-asset-service.js'

// App-owned registry of foundational services a DEPLOYMENT ships in code, mirroring the
// agent-kind / gate / pipeline / task-type registries: the composition root news one instance
// (`defaultFoundationalServiceRegistry()`), a deployment registers its estate on it by
// reference, and the catalog service reads it back as the lowest-precedence `builtin` tier.
//
// Why a TIER rather than seeded rows (the pipeline-registry shape): a foundational service is a
// standing fact about the org's estate, not a starting point someone edits. Copying it into
// every workspace at creation would make code and rows drift the moment a contract changes, and
// would need a reseed/version protocol to un-drift — for documents that can run to hundreds of
// kilobytes each. Read as a tier, the definitions are present from a workspace's FIRST request,
// can never be stale, and are still overridable by id and suppressible by tombstone at either
// stored tier, exactly like a built-in prompt fragment.
//
// Engine-level, not persistence: nothing here is stored, so both runtime facades get identical
// behaviour by building the same registry and injecting it. A definition is validated at BOOT
// (`validateRegistrations`), which is the property that makes code registration worth having —
// a malformed contract fails the deployment rather than a design dispatch months later.

/**
 * A foundational service a deployment registers in code.
 *
 * Deliberately the SAME shape the REST write boundary accepts
 * ({@link CreateFoundationalServiceInput}), so a definition is validated by the same schema and
 * the same document checks wherever it comes from, and so a service can be moved between code
 * and a stored tier without being rewritten.
 */
export type FoundationalServiceDefinition = CreateFoundationalServiceInput

/** A registered definition, projected for the catalog merge (identity, never a body). */
export interface FoundationalServiceRegistryEntry {
  id: string
  name: string
  summary: string
  description: string
  capabilities: string[]
  contracts: ApiContractSummary[]
}

/**
 * App-owned registry of deployment-registered foundational services. The composition root news
 * ONE instance and a deployment registers its services on it by reference; the catalog service
 * merges them under the account tier and serves their documents to the lazy contract read.
 */
export class FoundationalServiceRegistry {
  private readonly definitions = new Map<string, FoundationalServiceDefinition>()
  /**
   * Memoised projection. Building it parses every registered OpenAPI document, and the catalog
   * is resolved per workspace — on the Worker, per isolate — so doing it once per registration
   * set keeps that cost off the request path without pinning it to boot, where a deployment
   * that registers nothing would still pay it.
   *
   * The catalog manifests and the lazy read's documents are built TOGETHER, from one summary
   * per contract: a consumer must never see a document whose operation list disagrees with the
   * one the design was chosen from, and two independent projections is exactly how that drifts.
   */
  private projection: {
    entries: FoundationalServiceRegistryEntry[]
    documents: Map<string, ApiContractDocument[]>
  } | null = null

  /** Register a service. A registration whose id matches an earlier one replaces it. */
  register(definition: FoundationalServiceDefinition): void {
    this.definitions.set(definition.id, definition)
    this.projection = null
  }

  /** Register several services at once. */
  registerAll(definitions: Iterable<FoundationalServiceDefinition>): void {
    for (const definition of definitions) this.register(definition)
  }

  /** The registered definitions, contract bodies included (registration order). */
  all(): FoundationalServiceDefinition[] {
    return [...this.definitions.values()]
  }

  /** The registered definition for `id`, or undefined. */
  get(id: string): FoundationalServiceDefinition | undefined {
    return this.definitions.get(id)
  }

  /** The catalog projection of every registered service — identity and manifests, no bodies. */
  entries(): FoundationalServiceRegistryEntry[] {
    return this.build().entries
  }

  /** The full contract documents of one registered service — the lazy read's `builtin` half. */
  documentsFor(id: string): ApiContractDocument[] {
    return this.build().documents.get(id) ?? []
  }

  private build(): {
    entries: FoundationalServiceRegistryEntry[]
    documents: Map<string, ApiContractDocument[]>
  } {
    if (this.projection) return this.projection
    const entries: FoundationalServiceRegistryEntry[] = []
    const documents = new Map<string, ApiContractDocument[]>()
    for (const definition of this.definitions.values()) {
      const summarized = (definition.contracts ?? []).map((contract) => ({
        summary: summarizeContract({
          contractId: contract.contractId,
          format: contract.format,
          title: contract.title,
          // A registered definition has no repo provenance: its source of truth is the
          // deployment's own code, which no path of ours can name.
          path: null,
          body: contract.body,
        }),
        body: contract.body,
      }))
      entries.push({
        id: definition.id,
        name: definition.name,
        summary: definition.summary,
        description: definition.description,
        capabilities: definition.capabilities ?? [],
        contracts: summarized.map((c) => c.summary),
      })
      documents.set(
        definition.id,
        summarized.map((c) => ({ ...c.summary, body: c.body })),
      )
    }
    this.projection = { entries, documents }
    return this.projection
  }
}

/**
 * The foundational services the platform ships, in registration order: today the ONE service its
 * own asset storage ({@link platformAssetStorageService}) is.
 *
 * There is no shared BUSINESS capability every organisation runs, which is why the default catalog
 * held nothing for as long as the tier existed. The platform's own asset store is a different
 * claim: it is a capability every deployment of THIS platform runs, it is the target a
 * binary-output step must select before it can be configured at all, and a deployment that prefers
 * its own store registers that one and suppresses this id at either stored tier, exactly as it can
 * any other `builtin`.
 *
 * Exported as data, and shared by reference across every registry rather than rebuilt per one, so
 * a caller can ask whether a registration IS the platform's own instead of merely carrying its id.
 * Those are different questions with opposite answers, and the local facade's mothership warning
 * is the caller that needs the distinction: a deployment that registered this service should hear
 * nothing, one that REPLACED it under the same id should hear that the replacement is inert on a
 * node. {@link deepFreeze} is what makes sharing safe, taking over from the per-registry copies
 * that used to buy the same isolation at the cost of the identity.
 *
 * The sibling shape is `@cat-factory/binary-generators`' `BUILTIN_BINARY_GENERATORS`.
 */
export const PLATFORM_FOUNDATIONAL_SERVICES: readonly FoundationalServiceDefinition[] = deepFreeze([
  platformAssetStorageService(),
])

/**
 * A fresh foundational-service registry holding {@link PLATFORM_FOUNDATIONAL_SERVICES}. Each
 * facade news one and a deployment registers its estate on top.
 */
export function defaultFoundationalServiceRegistry(): FoundationalServiceRegistry {
  const registry = new FoundationalServiceRegistry()
  for (const service of PLATFORM_FOUNDATIONAL_SERVICES) registry.register(service)
  return registry
}
