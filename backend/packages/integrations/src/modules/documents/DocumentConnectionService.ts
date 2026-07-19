import type { Clock } from '@cat-factory/kernel'
import type { DocumentConnectionRecord, DocumentConnectionRepository } from '@cat-factory/kernel'
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

export interface DocumentConnectionServiceDependencies {
  documentConnectionRepository: DocumentConnectionRepository
  registry: DocumentSourceRegistry
  workspaceRepository: WorkspaceRepository
  clock: Clock
}

function toConnection(record: DocumentConnectionRecord): DocumentConnection {
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

    const existing = await this.deps.documentConnectionRepository.getByWorkspace(
      workspaceId,
      source,
    )
    const record: DocumentConnectionRecord = {
      workspaceId,
      source,
      credentials: normalized.credentials,
      label: normalized.label,
      createdAt: existing?.createdAt ?? this.deps.clock.now(),
      deletedAt: null,
    }
    await this.deps.documentConnectionRepository.upsert(record)
    return toConnection(record)
  }

  /** The current connection for a source, or null if not connected. */
  async getConnection(
    workspaceId: string,
    source: DocumentSourceKind,
  ): Promise<DocumentConnection | null> {
    const record = await this.deps.documentConnectionRepository.getByWorkspace(workspaceId, source)
    if (record) return toConnection(record)
    const implicit = await this.resolveImplicit(workspaceId, source)
    return implicit ? toConnection(implicit) : null
  }

  /**
   * Every live connection the workspace holds, across sources — the stored
   * (credentialed) connections PLUS any source that is implicitly connected via an
   * out-of-band credential (GitHub docs on the workspace's installed App). A stored
   * row always wins, so an explicitly-connected source is never duplicated.
   */
  async listConnections(workspaceId: string): Promise<DocumentConnection[]> {
    const records = await this.deps.documentConnectionRepository.listByWorkspace(workspaceId)
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
    const record = await this.deps.documentConnectionRepository.getByWorkspace(workspaceId, source)
    if (record) return record
    const implicit = await this.resolveImplicit(workspaceId, source)
    if (implicit) return implicit
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

  /** Disconnect a source (tombstones the binding). */
  async disconnect(workspaceId: string, source: DocumentSourceKind): Promise<void> {
    const record = await this.deps.documentConnectionRepository.getByWorkspace(workspaceId, source)
    if (!record) return
    await this.deps.documentConnectionRepository.softDelete(
      workspaceId,
      source,
      this.deps.clock.now(),
    )
  }
}
