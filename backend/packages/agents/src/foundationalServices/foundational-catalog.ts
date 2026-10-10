import type {
  FoundationalService,
  FoundationalServiceTier,
  ResolvedFoundationalService,
} from '@cat-factory/contracts'
import type {
  ApiContractManifestEntry,
  FoundationalServiceRecord,
  FoundationalServiceRegistryEntry,
} from '@cat-factory/kernel'

// Pure tier-merge for the foundational-services catalog. No I/O — the service hands in the
// two tiers' rows plus their contract manifests, so every precedence rule here is
// unit-testable and identical on both runtimes.

/** A stored record + its contract manifest → the wire shape. */
export function toWire(
  record: FoundationalServiceRecord,
  manifest: ApiContractManifestEntry[],
): FoundationalService {
  return {
    id: record.serviceId,
    ownerKind: record.ownerKind,
    name: record.name,
    summary: record.summary,
    description: record.description,
    capabilities: record.capabilities,
    contracts: manifest.map((entry) => ({
      contractId: entry.contractId,
      format: entry.format,
      title: entry.title,
      size: entry.size,
      path: entry.sourcePath,
      // Indexed once at WRITE time and stored on the row, so this projection shows an agent
      // what the interface offers without loading a single document body.
      operations: entry.operations,
      omittedOperations: entry.omittedOperations,
    })),
    sourceId: record.sourceId,
    sourcePath: record.sourcePath,
    pinnedCommit: record.pinnedCommit,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  }
}

export interface MergeFoundationalTiersInput {
  /** The DEPLOYMENT's own services, registered in code on the `FoundationalServiceRegistry`. */
  builtins: FoundationalServiceRegistryEntry[]
  /** Read `includeDeleted` — an account tombstone is what suppresses a registered builtin. */
  accountRows: FoundationalServiceRecord[]
  /** Read `includeDeleted` — a workspace tombstone is what suppresses an inherited service. */
  workspaceRows: FoundationalServiceRecord[]
  accountManifest: Map<string, ApiContractManifestEntry[]>
  workspaceManifest: Map<string, ApiContractManifestEntry[]>
}

/**
 * Merge the three tiers into the catalog an agent sees: the deployment's registered services,
 * then the account's rows, then the workspace's, each winning by id. A TOMBSTONE at either
 * stored tier removes the id entirely — including a service that tier never authored, which is
 * the whole point of reading both stored tiers with tombstones included, and is what lets an
 * account opt out of a deployment builtin exactly as a board opts out of an account service.
 *
 * Sorted by id so a catalog rendered into a prompt is byte-stable across resolves; an unstable
 * order would break prompt caching for every design dispatch in the workspace.
 */
export function mergeFoundationalTiers(
  input: MergeFoundationalTiersInput,
): ResolvedFoundationalService[] {
  const merged = new Map<string, ResolvedFoundationalService>()
  for (const builtin of input.builtins) merged.set(builtin.id, { ...builtin, tier: 'builtin' })
  applyTier(merged, input.accountRows, input.accountManifest, 'account')
  applyTier(merged, input.workspaceRows, input.workspaceManifest, 'workspace')
  return [...merged.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
}

function applyTier(
  merged: Map<string, ResolvedFoundationalService>,
  rows: FoundationalServiceRecord[],
  manifest: Map<string, ApiContractManifestEntry[]>,
  tier: FoundationalServiceTier,
): void {
  for (const row of rows) {
    if (row.deletedAt) merged.delete(row.serviceId)
    else merged.set(row.serviceId, entry(row, manifest, tier))
  }
}

function entry(
  record: FoundationalServiceRecord,
  manifest: Map<string, ApiContractManifestEntry[]>,
  tier: FoundationalServiceTier,
): ResolvedFoundationalService {
  const wire = toWire(record, manifest.get(record.serviceId) ?? [])
  return {
    id: wire.id,
    name: wire.name,
    summary: wire.summary,
    description: wire.description,
    capabilities: wire.capabilities,
    contracts: wire.contracts,
    tier,
  }
}
