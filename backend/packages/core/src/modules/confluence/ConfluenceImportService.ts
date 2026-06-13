import type { Clock } from '../../ports/runtime'
import type { ConfluenceClient } from '../../ports/confluence-client'
import type {
  ConfluenceDocumentRecord,
  ConfluenceDocumentRepository,
} from '../../ports/confluence-repositories'
import type { ConfluenceDocument } from '../../domain/types'
import { ValidationError } from '../../domain/errors'
import { requireWorkspace } from '../workspaces/WorkspaceService'
import type { WorkspaceRepository } from '../../ports/repositories'
import type { ConfluenceConnectionService } from './ConfluenceConnectionService'
import { buildExcerpt, parsePageId } from './confluence.logic'

// ConfluenceImportService: fetches a Confluence page for a connected workspace
// and persists it as a local document projection. The cached body backs both the
// planner (doc → board structure) and the agent-context injection, so an import
// is the prerequisite for spawning structure or linking context.

export interface ConfluenceImportServiceDependencies {
  confluenceClient: ConfluenceClient
  confluenceDocumentRepository: ConfluenceDocumentRepository
  connectionService: ConfluenceConnectionService
  workspaceRepository: WorkspaceRepository
  clock: Clock
}

/** Project a stored document record onto the wire shape (drops body + tombstone). */
export function toConfluenceDocument(record: ConfluenceDocumentRecord): ConfluenceDocument {
  return {
    pageId: record.pageId,
    spaceKey: record.spaceKey,
    title: record.title,
    url: record.url,
    version: record.version,
    excerpt: record.excerpt,
    linkedBlockId: record.linkedBlockId,
    syncedAt: record.syncedAt,
  }
}

export class ConfluenceImportService {
  constructor(private readonly deps: ConfluenceImportServiceDependencies) {}

  /** Fetch a page (by id or URL) and upsert its projection; returns the document. */
  async import(workspaceId: string, page: string): Promise<ConfluenceDocument> {
    await requireWorkspace(this.deps.workspaceRepository, workspaceId)
    const pageId = parsePageId(page)
    if (!pageId) {
      throw new ValidationError(`Could not resolve a Confluence page id from '${page}'`)
    }
    const connection = await this.deps.connectionService.requireConnection(workspaceId)
    const content = await this.deps.confluenceClient.getPage(
      {
        baseUrl: connection.baseUrl,
        email: connection.accountEmail,
        apiToken: connection.apiToken,
      },
      pageId,
    )

    // Preserve any existing block link across a re-import.
    const existing = await this.deps.confluenceDocumentRepository.get(workspaceId, content.pageId)
    const record: ConfluenceDocumentRecord = {
      workspaceId,
      pageId: content.pageId,
      spaceKey: content.spaceKey,
      title: content.title,
      url: content.url,
      version: content.version,
      excerpt: buildExcerpt(content.body),
      body: content.body,
      linkedBlockId: existing?.linkedBlockId ?? null,
      syncedAt: this.deps.clock.now(),
      deletedAt: null,
    }
    await this.deps.confluenceDocumentRepository.upsert(record)
    return toConfluenceDocument(record)
  }

  /** Every document imported into the workspace, as wire shapes. */
  async listDocuments(workspaceId: string): Promise<ConfluenceDocument[]> {
    const records = await this.deps.confluenceDocumentRepository.listByWorkspace(workspaceId)
    return records.map(toConfluenceDocument)
  }

  /** Resolve a stored document record (with body) or throw if not imported. */
  async requireDocument(workspaceId: string, pageId: string): Promise<ConfluenceDocumentRecord> {
    const record = await this.deps.confluenceDocumentRepository.get(workspaceId, pageId)
    if (!record) {
      throw new ValidationError(`Confluence page '${pageId}' has not been imported`)
    }
    return record
  }
}
