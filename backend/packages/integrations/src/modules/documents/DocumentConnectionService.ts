import type { Clock, GroupCacheHandle, LinkedDocumentRefreshOutcome } from '@cat-factory/kernel'
import type { DocumentConnectionRecord, DocumentConnectionStore } from '@cat-factory/kernel'
import type { DocumentSourceRegistry } from '@cat-factory/kernel'
import type {
  DocumentConnection,
  DocumentSourceDescriptor,
  DocumentSourceKind,
} from '@cat-factory/kernel'
import { ConflictError, ValidationError } from '@cat-factory/kernel'
import { requireWorkspace } from '@cat-factory/kernel'
import type { WorkspaceRepository } from '@cat-factory/kernel'

// DocumentConnectionService: owns the binding between a cat-factory workspace and an
// external document source. Connecting delegates credential validation to the source's
// provider, then stores the credential bag; the import path resolves it to authenticate.
// Credentials are never exposed back to clients — only the safe connection metadata
// (source, label, timestamp) is. Every source is workspace-scoped: a single sealed
// credential shared by everyone in the workspace.
//
// The bag is sealed in the STORE (`createDocumentConnectionStore`), not in the repository, so a
// deployment holding no key for these rows — a mothership-mode node — still resolves them, by
// naming the row over `/internal/secrets/unseal`.

export interface DocumentConnectionServiceDependencies {
  documentConnectionStore: DocumentConnectionStore
  registry: DocumentSourceRegistry
  workspaceRepository: WorkspaceRepository
  clock: Clock
  /**
   * The dispatch-time freshness cache, so connecting or disconnecting a source drops every
   * verdict that connection authorised. Optional only so the service stays unit-testable
   * standalone; a deployment that caches and does not invalidate would compare a run's documents
   * against a token fetched with a credential the workspace has since replaced.
   */
  versionCache?: GroupCacheHandle<LinkedDocumentRefreshOutcome>
}

/** The client-safe projection: everything but the credential bag. */
function toConnection(record: {
  source: DocumentSourceKind
  label: string
  createdAt: number
}): DocumentConnection {
  return {
    source: record.source,
    label: record.label,
    connectedAt: record.createdAt,
  }
}

export class DocumentConnectionService {
  constructor(private readonly deps: DocumentConnectionServiceDependencies) {}

  /** The descriptors of every configured source (drives the connect UI). */
  listSources(): DocumentSourceDescriptor[] {
    return this.deps.registry.list().map((p) => p.descriptor)
  }

  /** Resolve a provider for a source or throw if that source isn't configured. */
  private requireProvider(source: DocumentSourceKind) {
    const provider = this.deps.registry.get(source)
    if (!provider) throw new ValidationError(`Unknown or unconfigured document source '${source}'`)
    return provider
  }

  /** Connect (or re-connect) a workspace to a source; the credential is shared by the workspace. */
  async connect(
    workspaceId: string,
    source: DocumentSourceKind,
    credentials: Record<string, string>,
  ): Promise<DocumentConnection> {
    await requireWorkspace(this.deps.workspaceRepository, workspaceId)
    const provider = this.requireProvider(source)
    const normalized = provider.normalizeConnection(credentials)

    // The SUMMARY, because all this needs is the original `connectedAt`, and re-connecting is
    // precisely what an operator does when the stored bag is the thing that has gone wrong.
    // Opening it here would make the unopenable connection the one that cannot be replaced.
    const existing = await this.summaryFor(workspaceId, source)
    const record: DocumentConnectionRecord = {
      workspaceId,
      source,
      credentials: normalized.credentials,
      label: normalized.label,
      createdAt: existing?.createdAt ?? this.deps.clock.now(),
      deletedAt: null,
    }
    await this.deps.documentConnectionStore.upsert(record)
    // The freshness verdicts cached for this workspace were reached with the credential this call
    // just replaced, so drop the whole group rather than guessing which documents it covered.
    await this.deps.versionCache?.invalidateGroup(workspaceId)
    return toConnection(record)
  }

  /** The current connection for a source, or null if not connected. */
  async getConnection(
    workspaceId: string,
    source: DocumentSourceKind,
  ): Promise<DocumentConnection | null> {
    const record = await this.resolveConnection(workspaceId, source)
    return record ? toConnection(record) : null
  }

  /**
   * The live connection record (WITH credentials) for a source, or null when the workspace has
   * none. The non-throwing twin of {@link requireConnection}, and the one place the stored row ⊕
   * implicit-connection resolution lives.
   *
   * Exists because a caller that must tell "no connection" from "the read itself failed" cannot do
   * it through a thrown `ConflictError` without also catching every transport fault as the same
   * fact (`LinkedDocumentRefreshService` reports those as two different gaps, needing two different
   * fixes). Returning the RECORD rather than the safe projection means such a caller resolves the
   * credential once instead of asking again through `requireConnection`.
   */
  async resolveConnection(
    workspaceId: string,
    source: DocumentSourceKind,
  ): Promise<DocumentConnectionRecord | null> {
    const record = await this.deps.documentConnectionStore.getByWorkspace(workspaceId, source)
    return record ?? (await this.resolveImplicit(workspaceId, source))
  }

  /**
   * {@link resolveConnection} for SEVERAL sources in one stored-row read.
   *
   * The batch shape exists for the dispatch-time refresh, which asks about a whole corpus on every
   * step of every run: resolving per document (or even per document per source) is the N+1 this
   * repo bans, and the connection is invariant per `(workspace, source)` for the entire pass. Only
   * a source with NO stored row falls through to its provider's implicit resolution, which is an
   * out-of-band credential the provider owns and so has nothing to batch.
   */
  async resolveConnections(
    workspaceId: string,
    sources: readonly DocumentSourceKind[],
  ): Promise<Map<DocumentSourceKind, DocumentConnectionRecord | null>> {
    const wanted = new Set(sources)
    const resolved = new Map<DocumentSourceKind, DocumentConnectionRecord | null>()
    if (wanted.size === 0) return resolved
    // The named sources only: opening a bag for a source this corpus never mentions costs a
    // mothership-mode node a round trip for an answer nobody reads.
    const stored = await this.deps.documentConnectionStore.listBySources(workspaceId, [...wanted])
    for (const record of stored) resolved.set(record.source, record)
    await Promise.all(
      [...wanted]
        .filter((source) => !resolved.has(source))
        .map(async (source) => {
          resolved.set(source, await this.resolveImplicit(workspaceId, source))
        }),
    )
    return resolved
  }

  /**
   * Every live connection the workspace holds, across sources — the stored
   * (credentialed) connections PLUS any source that is implicitly connected via an
   * out-of-band credential (GitHub docs on the workspace's installed App). A stored
   * row always wins, so an explicitly-connected source is never duplicated.
   */
  async listConnections(workspaceId: string): Promise<DocumentConnection[]> {
    // Summaries, not records: this renders labels, and opening every workspace credential to
    // draw a settings panel would make one unopenable row fail the whole list.
    const records = await this.deps.documentConnectionStore.listSummaries(workspaceId)
    const connectedSources = new Set(records.map((r) => r.source))
    const connections = records.map(toConnection)
    for (const provider of this.deps.registry.list()) {
      if (connectedSources.has(provider.kind) || !provider.resolveImplicitConnection) continue
      const implicit = await provider.resolveImplicitConnection(workspaceId)
      if (implicit) {
        connections.push({
          source: provider.kind,
          label: implicit.label,
          connectedAt: this.deps.clock.now(),
        })
      }
    }
    return connections
  }

  /** Resolve the live connection (with credentials), or throw if not connected. */
  async requireConnection(
    workspaceId: string,
    source: DocumentSourceKind,
  ): Promise<DocumentConnectionRecord> {
    const record = await this.resolveConnection(workspaceId, source)
    if (record) return record
    throw new ConflictError(`Workspace '${workspaceId}' is not connected to ${source}`)
  }

  /**
   * Build a synthetic connection record for a source that is implicitly connected
   * via an out-of-band credential (the GitHub App), or null when it is not. Lets the
   * import / search / content-resolver paths treat an App-backed source as connected
   * without a stored marker row — the provider owns the credential resolution.
   */
  private async resolveImplicit(
    workspaceId: string,
    source: DocumentSourceKind,
  ): Promise<DocumentConnectionRecord | null> {
    const provider = this.deps.registry.get(source)
    if (!provider?.resolveImplicitConnection) return null
    const normalized = await provider.resolveImplicitConnection(workspaceId)
    if (!normalized) return null
    return {
      workspaceId,
      source,
      credentials: normalized.credentials,
      label: normalized.label,
      createdAt: this.deps.clock.now(),
      deletedAt: null,
    }
  }

  /** The stored connection's non-secret half, opening nothing. */
  private async summaryFor(
    workspaceId: string,
    source: DocumentSourceKind,
  ): Promise<{ createdAt: number } | undefined> {
    const summaries = await this.deps.documentConnectionStore.listSummaries(workspaceId)
    return summaries.find((summary) => summary.source === source)
  }

  /** Disconnect a source (tombstones the binding). */
  async disconnect(workspaceId: string, source: DocumentSourceKind): Promise<void> {
    // Presence, not the bag: removing a connection nobody can open is the other half of
    // `connect`'s remedy, so this must not be the call that needs the key.
    if (!(await this.summaryFor(workspaceId, source))) return
    await this.deps.documentConnectionStore.softDelete(workspaceId, source, this.deps.clock.now())
    // Same reason as `connect`: every cached verdict for this workspace was reached through a
    // credential that no longer exists, and the next dispatch must find that out rather than
    // report `confirmed` against a source it can no longer reach.
    await this.deps.versionCache?.invalidateGroup(workspaceId)
  }
}
