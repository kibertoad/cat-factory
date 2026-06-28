import type { Clock } from '@cat-factory/kernel'
import type {
  DocumentConnectionRecord,
  DocumentConnectionRepository,
  UserDocumentConnectionRecord,
  UserDocumentConnectionRepository,
} from '@cat-factory/kernel'
import type { DocumentSourceRegistry } from '@cat-factory/kernel'
import type {
  DocumentConnection,
  DocumentCredentialScope,
  DocumentSourceDescriptor,
  DocumentSourceKind,
} from '@cat-factory/kernel'
import { ConflictError, ValidationError } from '@cat-factory/kernel'
import { requireWorkspace } from '@cat-factory/kernel'
import type { WorkspaceRepository } from '@cat-factory/kernel'

// DocumentConnectionService: owns the binding between a cat-factory workspace (or, for a
// personal source, a single user) and an external document source. Connecting delegates
// credential validation to the source's provider, then stores the credential bag; the
// import path resolves it to authenticate. Credentials are never exposed back to clients
// — only the safe connection metadata (source, label, timestamp) is.
//
// A source's `descriptor.credentialScope` selects the store: `'workspace'` (the default)
// uses the shared per-workspace `documentConnectionRepository`; `'user'` uses the
// per-user `userDocumentConnectionRepository` (a personal PAT, e.g. Claude Design), keyed
// by the acting user's id so it is never shared. Everything downstream is unchanged — the
// scope only decides which table the credential is read from / written to.

export interface DocumentConnectionServiceDependencies {
  documentConnectionRepository: DocumentConnectionRepository
  /** Per-user store for personal (`credentialScope: 'user'`) sources; absent → such sources can't connect. */
  userDocumentConnectionRepository?: UserDocumentConnectionRepository
  registry: DocumentSourceRegistry
  workspaceRepository: WorkspaceRepository
  clock: Clock
}

function toConnection(
  record: DocumentConnectionRecord | UserDocumentConnectionRecord,
): DocumentConnection {
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

  /** Whether a source's credential is shared by the workspace or personal to a user. */
  private scopeOf(source: DocumentSourceKind): DocumentCredentialScope {
    return this.deps.registry.get(source)?.descriptor.credentialScope ?? 'workspace'
  }

  /** The per-user store, or a clear error when a personal source isn't backed by one. */
  private requireUserRepo(source: DocumentSourceKind): UserDocumentConnectionRepository {
    const repo = this.deps.userDocumentConnectionRepository
    if (!repo) {
      throw new ValidationError(
        `The ${source} source is personal but per-user credential storage is not configured`,
      )
    }
    return repo
  }

  /**
   * Connect (or re-connect) a source. For a workspace-scoped source the credential is
   * shared; for a personal (`credentialScope: 'user'`) source it is stored against
   * `ownerUserId` and never shared. `ownerUserId` is the acting user (`''` when auth is
   * disabled, so single-user/local deployments still work) and is ignored for workspace
   * sources.
   */
  async connect(
    workspaceId: string,
    source: DocumentSourceKind,
    credentials: Record<string, string>,
    ownerUserId = '',
  ): Promise<DocumentConnection> {
    await requireWorkspace(this.deps.workspaceRepository, workspaceId)
    const provider = this.requireProvider(source)
    const normalized = provider.normalizeConnection(credentials)

    if (this.scopeOf(source) === 'user') {
      const repo = this.requireUserRepo(source)
      const existing = await repo.getByUser(ownerUserId, source)
      const record: UserDocumentConnectionRecord = {
        userId: ownerUserId,
        source,
        credentials: normalized.credentials,
        label: normalized.label,
        createdAt: existing?.createdAt ?? this.deps.clock.now(),
        deletedAt: null,
      }
      await repo.upsert(record)
      return toConnection(record)
    }

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

  /** The current connection for a source (scope-aware), or null if not connected. */
  async getConnection(
    workspaceId: string,
    source: DocumentSourceKind,
    ownerUserId = '',
  ): Promise<DocumentConnection | null> {
    if (this.scopeOf(source) === 'user') {
      const record = await this.requireUserRepo(source).getByUser(ownerUserId, source)
      return record ? toConnection(record) : null
    }
    const record = await this.deps.documentConnectionRepository.getByWorkspace(workspaceId, source)
    return record ? toConnection(record) : null
  }

  /**
   * Every live connection visible here: the workspace's shared connections plus the
   * acting user's personal connections (when a user-scoped store is wired). A personal
   * connection shows up in every workspace its owner opens — it's their credential, not
   * the workspace's.
   */
  async listConnections(workspaceId: string, ownerUserId = ''): Promise<DocumentConnection[]> {
    const workspace = await this.deps.documentConnectionRepository.listByWorkspace(workspaceId)
    const personal = this.deps.userDocumentConnectionRepository
      ? await this.deps.userDocumentConnectionRepository.listByUser(ownerUserId)
      : []
    return [...workspace, ...personal].map(toConnection)
  }

  /** Resolve the live connection (with credentials), scope-aware, or throw if not connected. */
  async requireConnection(
    workspaceId: string,
    source: DocumentSourceKind,
    ownerUserId = '',
  ): Promise<DocumentConnectionRecord | UserDocumentConnectionRecord> {
    if (this.scopeOf(source) === 'user') {
      const record = await this.requireUserRepo(source).getByUser(ownerUserId, source)
      if (!record) {
        throw new ConflictError(`You are not connected to ${source}`)
      }
      return record
    }
    const record = await this.deps.documentConnectionRepository.getByWorkspace(workspaceId, source)
    if (!record) {
      throw new ConflictError(`Workspace '${workspaceId}' is not connected to ${source}`)
    }
    return record
  }

  /** Disconnect a source (scope-aware; tombstones the binding). */
  async disconnect(
    workspaceId: string,
    source: DocumentSourceKind,
    ownerUserId = '',
  ): Promise<void> {
    if (this.scopeOf(source) === 'user') {
      const repo = this.requireUserRepo(source)
      const record = await repo.getByUser(ownerUserId, source)
      if (!record) return
      await repo.softDelete(ownerUserId, source, this.deps.clock.now())
      return
    }
    const record = await this.deps.documentConnectionRepository.getByWorkspace(workspaceId, source)
    if (!record) return
    await this.deps.documentConnectionRepository.softDelete(
      workspaceId,
      source,
      this.deps.clock.now(),
    )
  }
}
