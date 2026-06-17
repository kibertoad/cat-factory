import type { Clock } from '@cat-factory/kernel'
import type {
  DocumentConnectionRecord,
  DocumentConnectionRepository,
} from '@cat-factory/kernel'
import type { DocumentSourceRegistry } from '@cat-factory/kernel'
import type {
  DocumentConnection,
  DocumentSourceDescriptor,
  DocumentSourceKind,
} from '@cat-factory/kernel'
import { ConflictError, ValidationError } from '@cat-factory/kernel'
import { requireWorkspace } from '@cat-factory/kernel'
import type { WorkspaceRepository } from '@cat-factory/kernel'

// DocumentConnectionService: owns the binding between a cat-factory workspace
// and an external document source. Connecting delegates credential validation to
// the source's provider, then stores the credential bag; the import path
// resolves it to authenticate. Credentials are never exposed back to clients —
// only the safe connection metadata (source, label, timestamp) is.

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

  /** Connect (or re-connect) a workspace to a document source. */
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

  /** The workspace's current connection for a source, or null if not connected. */
  async getConnection(
    workspaceId: string,
    source: DocumentSourceKind,
  ): Promise<DocumentConnection | null> {
    const record = await this.deps.documentConnectionRepository.getByWorkspace(workspaceId, source)
    return record ? toConnection(record) : null
  }

  /** Every live connection the workspace holds, across sources. */
  async listConnections(workspaceId: string): Promise<DocumentConnection[]> {
    const records = await this.deps.documentConnectionRepository.listByWorkspace(workspaceId)
    return records.map(toConnection)
  }

  /** Resolve the live connection (with credentials) or throw if not connected. */
  async requireConnection(
    workspaceId: string,
    source: DocumentSourceKind,
  ): Promise<DocumentConnectionRecord> {
    const record = await this.deps.documentConnectionRepository.getByWorkspace(workspaceId, source)
    if (!record) {
      throw new ConflictError(`Workspace '${workspaceId}' is not connected to ${source}`)
    }
    return record
  }

  /** Disconnect a workspace from a source (tombstones the binding). */
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
