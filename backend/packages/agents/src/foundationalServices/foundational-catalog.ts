import type {
  FoundationalService,
  FoundationalServiceTier,
  ResolvedFoundationalService,
} from '@cat-factory/contracts'
import type { ApiContractManifestEntry, FoundationalServiceRecord } from '@cat-factory/kernel'

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
  accountRows: FoundationalServiceRecord[]
  /** Read `includeDeleted` — a workspace tombstone is what suppresses an inherited service. */
  workspaceRows: FoundationalServiceRecord[]
  accountManifest: Map<string, ApiContractManifestEntry[]>
  workspaceManifest: Map<string, ApiContractManifestEntry[]>
}

/**
 * Merge the account and workspace tiers into the catalog an agent sees. The workspace tier
 * wins by id, and a workspace TOMBSTONE removes the id entirely — including an account service
 * the workspace never authored, which is the whole point of reading the workspace tier with
 * tombstones included.
 *
 * Sorted by id so a catalog rendered into a prompt is byte-stable across resolves; an unstable
 * order would break prompt caching for every design dispatch in the workspace.
 */
export function mergeFoundationalTiers(
  input: MergeFoundationalTiersInput,
): ResolvedFoundationalService[] {
  const merged = new Map<string, ResolvedFoundationalService>()
  for (const row of input.accountRows) {
    if (row.deletedAt) continue
    merged.set(row.serviceId, entry(row, input.accountManifest, 'account'))
  }
  for (const row of input.workspaceRows) {
    if (row.deletedAt) merged.delete(row.serviceId)
    else merged.set(row.serviceId, entry(row, input.workspaceManifest, 'workspace'))
  }
  return [...merged.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
}

function entry(
  record: FoundationalServiceRecord,
  manifest: Map<string, ApiContractManifestEntry[]>,
  tier: FoundationalServiceTier,
): ResolvedFoundationalService {
  return { ...toWire(record, manifest.get(record.serviceId) ?? []), tier }
}
