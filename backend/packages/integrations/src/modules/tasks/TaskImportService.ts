import type { Clock, TaskContent, TaskSearchRepoScope } from '@cat-factory/kernel'
import type { TaskCredentials, TaskSourceProvider, TaskSourceRegistry } from '@cat-factory/kernel'
import type { TaskRecord, TaskRepository } from '@cat-factory/kernel'
import type { SourceTask, TaskSearchResult, TaskSourceKind } from '@cat-factory/kernel'
import { ConflictError, ValidationError } from '@cat-factory/kernel'
import { requireWorkspace } from '@cat-factory/kernel'
import type { WorkspaceRepository } from '@cat-factory/kernel'
import type { TaskConnectionService } from './TaskConnectionService.js'
import { buildTaskExcerpt } from './tasks.logic.js'

// TaskImportService: fetches an issue from a connected source and persists it as
// a local, structured projection. The cached record backs both the agent-context
// injection and the list/preview rendering, so an import is the prerequisite for
// linking an issue to a block. Source specifics (ref parsing, fetching) are
// delegated to the source's provider.

export interface TaskImportServiceDependencies {
  registry: TaskSourceRegistry
  taskRepository: TaskRepository
  connectionService: TaskConnectionService
  workspaceRepository: WorkspaceRepository
  clock: Clock
}

/** Project a stored task record onto the wire shape (drops the tombstone). */
export function toSourceTask(record: TaskRecord): SourceTask {
  return {
    source: record.source,
    externalId: record.externalId,
    title: record.title,
    url: record.url,
    status: record.status,
    type: record.type,
    assignee: record.assignee,
    priority: record.priority,
    labels: record.labels,
    description: record.description,
    comments: record.comments,
    excerpt: record.excerpt,
    linkedBlockId: record.linkedBlockId,
    syncedAt: record.syncedAt,
  }
}

export class TaskImportService {
  constructor(private readonly deps: TaskImportServiceDependencies) {}

  private requireProvider(source: TaskSourceKind) {
    const provider = this.deps.registry.get(source)
    if (!provider) throw new ValidationError(`Unknown or unconfigured task source '${source}'`)
    return provider
  }

  /**
   * Enforce the workspace's toggle and resolve the credentials to authenticate
   * with. A disabled source is refused (it isn't offered, so neither import nor
   * search may run against it). A credentialless source (GitHub Issues) needs no
   * stored connection — it rides the workspace's installed GitHub App — so it
   * authenticates with an empty bag; a credentialed source requires a connection.
   */
  private async resolveCredentials(
    workspaceId: string,
    source: TaskSourceKind,
    provider: TaskSourceProvider,
  ): Promise<TaskCredentials> {
    if (!(await this.deps.connectionService.isEnabled(workspaceId, source))) {
      throw new ConflictError(`The ${source} task source is disabled for this workspace`)
    }
    if (provider.descriptor.credentialFields.length === 0) return {}
    const connection = await this.deps.connectionService.requireConnection(workspaceId, source)
    return connection.credentials
  }

  /** Fetch an issue (by key or URL) and upsert its projection; returns the issue. */
  async import(workspaceId: string, source: TaskSourceKind, ref: string): Promise<SourceTask> {
    return (await this.importDetailed(workspaceId, source, ref)).task
  }

  /**
   * As {@link import}, but also returns the provider's full {@link TaskContent} — including
   * the transient hierarchy/dependency fields (isEpic / parent / children / links) that
   * the projection drops. The epic-spawn import uses these to build the board graph; the
   * persisted projection still backs agent-context + list rendering.
   */
  async importDetailed(
    workspaceId: string,
    source: TaskSourceKind,
    ref: string,
  ): Promise<{ task: SourceTask; content: TaskContent }> {
    await requireWorkspace(this.deps.workspaceRepository, workspaceId)
    const provider = this.requireProvider(source)
    const externalId = provider.parseRef(ref)
    if (!externalId) {
      throw new ValidationError(`Could not resolve a ${source} issue key from '${ref}'`)
    }
    const credentials = await this.resolveCredentials(workspaceId, source, provider)
    const content = await provider.fetchTask(credentials, externalId)

    // Preserve any existing block link across a re-import.
    const existing = await this.deps.taskRepository.get(workspaceId, source, content.externalId)
    const record: TaskRecord = {
      workspaceId,
      source,
      externalId: content.externalId,
      title: content.title,
      url: content.url,
      status: content.status,
      type: content.type,
      assignee: content.assignee,
      priority: content.priority,
      labels: content.labels,
      description: content.description,
      comments: content.comments,
      excerpt: buildTaskExcerpt(content),
      linkedBlockId: existing?.linkedBlockId ?? null,
      syncedAt: this.deps.clock.now(),
      deletedAt: null,
    }
    await this.deps.taskRepository.upsert(record)
    return { task: toSourceTask(record), content }
  }

  /**
   * Search a tracker by free text, returning lean hits (not yet imported). The
   * provider authenticates with the workspace's stored credentials and builds/
   * parses the source-specific query. Throws if the source can't search (no
   * provider `search`), so the controller can answer cleanly.
   *
   * `scope` (resolved by the controller from the search's originating block) pins
   * a repo-backed source to one repository; the provider ignores it when the
   * source has no repo notion.
   */
  async search(
    workspaceId: string,
    source: TaskSourceKind,
    query: string,
    scope?: TaskSearchRepoScope,
  ): Promise<TaskSearchResult[]> {
    await requireWorkspace(this.deps.workspaceRepository, workspaceId)
    const provider = this.requireProvider(source)
    if (!provider.search) {
      throw new ValidationError(`The ${source} source does not support search`)
    }
    const credentials = await this.resolveCredentials(workspaceId, source, provider)
    return provider.search(credentials, query, workspaceId, scope)
  }

  /** Every issue imported into the workspace, across sources, as wire shapes. */
  async listTasks(workspaceId: string): Promise<SourceTask[]> {
    const records = await this.deps.taskRepository.listByWorkspace(workspaceId)
    return records.map(toSourceTask)
  }

  /** Resolve a stored task record or throw if not imported. */
  async requireTask(
    workspaceId: string,
    source: TaskSourceKind,
    externalId: string,
  ): Promise<TaskRecord> {
    const record = await this.deps.taskRepository.get(workspaceId, source, externalId)
    if (!record) {
      throw new ValidationError(`${source} issue '${externalId}' has not been imported`)
    }
    return record
  }
}
