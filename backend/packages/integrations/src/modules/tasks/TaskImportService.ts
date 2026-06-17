import type { Clock } from '@cat-factory/kernel'
import type { TaskSourceRegistry } from '@cat-factory/kernel'
import type { TaskRecord, TaskRepository } from '@cat-factory/kernel'
import type { SourceTask, TaskSourceKind } from '@cat-factory/kernel'
import { ValidationError } from '@cat-factory/kernel'
import { requireWorkspace } from '@cat-factory/kernel'
import type { WorkspaceRepository } from '@cat-factory/kernel'
import type { TaskConnectionService } from './TaskConnectionService'
import { buildTaskExcerpt } from './tasks.logic'

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

  /** Fetch an issue (by key or URL) and upsert its projection; returns the issue. */
  async import(workspaceId: string, source: TaskSourceKind, ref: string): Promise<SourceTask> {
    await requireWorkspace(this.deps.workspaceRepository, workspaceId)
    const provider = this.requireProvider(source)
    const externalId = provider.parseRef(ref)
    if (!externalId) {
      throw new ValidationError(`Could not resolve a ${source} issue key from '${ref}'`)
    }
    const connection = await this.deps.connectionService.requireConnection(workspaceId, source)
    const content = await provider.fetchTask(connection.credentials, externalId)

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
    return toSourceTask(record)
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
