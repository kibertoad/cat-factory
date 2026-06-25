import type { Clock } from '@cat-factory/kernel'
import type { TaskConnectionRecord, TaskConnectionRepository } from '@cat-factory/kernel'
import type { TaskSourceSettingsRepository } from '@cat-factory/kernel'
import type { GitHubInstallationRepository } from '@cat-factory/kernel'
import type { TaskSourceProvider, TaskSourceRegistry } from '@cat-factory/kernel'
import type { TaskConnection, TaskSourceKind, TaskSourceState } from '@cat-factory/kernel'
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
  /** Per-workspace on/off toggle for each source (absent row ⇒ enabled). */
  taskSourceSettingsRepository: TaskSourceSettingsRepository
  registry: TaskSourceRegistry
  workspaceRepository: WorkspaceRepository
  clock: Clock
  /**
   * Resolves the workspace's installed GitHub App, used to decide whether the
   * credentialless GitHub Issues source is available (it rides that App). Absent
   * when the GitHub integration isn't wired, in which case GitHub Issues — if its
   * provider is even registered — is reported unavailable.
   */
  installations?: GitHubInstallationRepository
}

/**
 * A credentialless provider (today only GitHub Issues) carries no connection: it
 * authenticates out-of-band via the workspace's installed GitHub App. Such a
 * source is never "connected"; its availability is the App's presence instead.
 */
function isCredentialless(provider: TaskSourceProvider): boolean {
  return provider.descriptor.credentialFields.length === 0
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

  /**
   * Every configured source with the workspace's live state for it (drives the
   * settings + import UI): each source's descriptor plus whether it is available
   * now and whether the workspace has it enabled. Availability is connection
   * presence for credentialed sources, and the installed GitHub App for the
   * credentialless GitHub Issues source.
   */
  async listSourceStates(workspaceId: string): Promise<TaskSourceState[]> {
    const settings = await this.deps.taskSourceSettingsRepository.getByWorkspace(workspaceId)
    const enabledBySource = new Map(settings.map((s) => [s.source, s.enabled]))
    const states: TaskSourceState[] = []
    for (const provider of this.deps.registry.list()) {
      states.push({
        ...provider.descriptor,
        available: await this.isAvailable(workspaceId, provider),
        // No row ⇒ default enabled, so a source is offered as soon as it's available.
        enabled: enabledBySource.get(provider.kind) ?? true,
      })
    }
    return states
  }

  /** Whether a source can be used right now (drives the import gate + the UI toggle's enablement). */
  private async isAvailable(workspaceId: string, provider: TaskSourceProvider): Promise<boolean> {
    if (isCredentialless(provider)) {
      // GitHub Issues rides the workspace's installed GitHub App: available once installed.
      if (!this.deps.installations) return false
      return (await this.deps.installations.getByWorkspace(workspaceId)) !== null
    }
    return (
      (await this.deps.taskConnectionRepository.getByWorkspace(workspaceId, provider.kind)) !== null
    )
  }

  /** The workspace's toggle for a source (defaults to enabled when no row exists). */
  async isEnabled(workspaceId: string, source: TaskSourceKind): Promise<boolean> {
    const row = await this.deps.taskSourceSettingsRepository.get(workspaceId, source)
    return row?.enabled ?? true
  }

  /** Enable or disable a source for the workspace (the per-workspace toggle). */
  async setEnabled(workspaceId: string, source: TaskSourceKind, enabled: boolean): Promise<void> {
    await requireWorkspace(this.deps.workspaceRepository, workspaceId)
    this.requireProvider(source)
    await this.deps.taskSourceSettingsRepository.upsert({ workspaceId, source, enabled })
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
    if (isCredentialless(provider)) {
      // A credentialless source has no connection to make: it rides the workspace's
      // installed GitHub App and is toggled via setEnabled, not connected.
      throw new ValidationError(
        `The ${source} source has no connection to configure; it uses the workspace's installed GitHub App. Enable or disable it instead.`,
      )
    }
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
