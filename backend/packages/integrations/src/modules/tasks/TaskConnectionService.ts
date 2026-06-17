import type { Clock } from '@cat-factory/kernel'
import type { TaskConnectionRecord, TaskConnectionRepository } from '@cat-factory/kernel'
import type { TaskSourceRegistry } from '@cat-factory/kernel'
import type { TaskConnection, TaskSourceDescriptor, TaskSourceKind } from '@cat-factory/kernel'
import { ConflictError, ValidationError } from '@cat-factory/kernel'
import { requireWorkspace } from '@cat-factory/kernel'
import type { WorkspaceRepository } from '@cat-factory/kernel'

// TaskConnectionService: owns the binding between a cat-factory workspace and an
// external task source. Connecting delegates credential validation to the
// source's provider, then stores the credential bag; the import path resolves it
// to authenticate. Credentials are never exposed back to clients — only the safe
// connection metadata (source, label, timestamp) is.

export interface TaskConnectionServiceDependencies {
  taskConnectionRepository: TaskConnectionRepository
  registry: TaskSourceRegistry
  workspaceRepository: WorkspaceRepository
  clock: Clock
}

function toConnection(record: TaskConnectionRecord): TaskConnection {
  return {
    source: record.source,
    label: record.label,
    connectedAt: record.createdAt,
  }
}

export class TaskConnectionService {
  constructor(private readonly deps: TaskConnectionServiceDependencies) {}

  /** The descriptors of every configured source (drives the connect UI). */
  listSources(): TaskSourceDescriptor[] {
    return this.deps.registry.list().map((p) => p.descriptor)
  }

  /** Resolve a provider for a source or throw if that source isn't configured. */
  private requireProvider(source: TaskSourceKind) {
    const provider = this.deps.registry.get(source)
    if (!provider) throw new ValidationError(`Unknown or unconfigured task source '${source}'`)
    return provider
  }

  /** Connect (or re-connect) a workspace to a task source. */
  async connect(
    workspaceId: string,
    source: TaskSourceKind,
    credentials: Record<string, string>,
  ): Promise<TaskConnection> {
    await requireWorkspace(this.deps.workspaceRepository, workspaceId)
    const provider = this.requireProvider(source)
    const normalized = provider.normalizeConnection(credentials)
    const existing = await this.deps.taskConnectionRepository.getByWorkspace(workspaceId, source)
    const record: TaskConnectionRecord = {
      workspaceId,
      source,
      credentials: normalized.credentials,
      label: normalized.label,
      createdAt: existing?.createdAt ?? this.deps.clock.now(),
      deletedAt: null,
    }
    await this.deps.taskConnectionRepository.upsert(record)
    return toConnection(record)
  }

  /** The workspace's current connection for a source, or null if not connected. */
  async getConnection(workspaceId: string, source: TaskSourceKind): Promise<TaskConnection | null> {
    const record = await this.deps.taskConnectionRepository.getByWorkspace(workspaceId, source)
    return record ? toConnection(record) : null
  }

  /** Every live connection the workspace holds, across sources. */
  async listConnections(workspaceId: string): Promise<TaskConnection[]> {
    const records = await this.deps.taskConnectionRepository.listByWorkspace(workspaceId)
    return records.map(toConnection)
  }

  /** Resolve the live connection (with credentials) or throw if not connected. */
  async requireConnection(
    workspaceId: string,
    source: TaskSourceKind,
  ): Promise<TaskConnectionRecord> {
    const record = await this.deps.taskConnectionRepository.getByWorkspace(workspaceId, source)
    if (!record) {
      throw new ConflictError(`Workspace '${workspaceId}' is not connected to ${source}`)
    }
    return record
  }

  /** Disconnect a workspace from a source (tombstones the binding). */
  async disconnect(workspaceId: string, source: TaskSourceKind): Promise<void> {
    const record = await this.deps.taskConnectionRepository.getByWorkspace(workspaceId, source)
    if (!record) return
    await this.deps.taskConnectionRepository.softDelete(workspaceId, source, this.deps.clock.now())
  }
}
