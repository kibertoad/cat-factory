import type { Clock } from '@cat-factory/kernel'
import type { DocumentSourceRegistry } from '@cat-factory/kernel'
import type { DocumentRecord, DocumentRepository } from '@cat-factory/kernel'
import type { SourceDocument, DocumentSourceKind } from '@cat-factory/kernel'
import { ValidationError } from '@cat-factory/kernel'
import { requireWorkspace } from '@cat-factory/kernel'
import type { WorkspaceRepository } from '@cat-factory/kernel'
import type { DocumentConnectionService } from './DocumentConnectionService.js'
import { buildExcerpt } from './documents.logic.js'

// DocumentImportService: fetches a page from a connected source and persists it
// as a local document projection. The cached body backs both the planner (doc →
// board structure) and the agent-context injection, so an import is the
// prerequisite for spawning structure or linking context. Source specifics
// (ref parsing, fetching) are delegated to the source's provider.

export interface DocumentImportServiceDependencies {
  registry: DocumentSourceRegistry
  documentRepository: DocumentRepository
  connectionService: DocumentConnectionService
  workspaceRepository: WorkspaceRepository
  clock: Clock
}

/** Project a stored document record onto the wire shape (drops body + tombstone). */
export function toSourceDocument(record: DocumentRecord): SourceDocument {
  return {
    source: record.source,
    externalId: record.externalId,
    title: record.title,
    url: record.url,
    excerpt: record.excerpt,
    linkedBlockId: record.linkedBlockId,
    syncedAt: record.syncedAt,
  }
}

export class DocumentImportService {
  constructor(private readonly deps: DocumentImportServiceDependencies) {}

  private requireProvider(source: DocumentSourceKind) {
    const provider = this.deps.registry.get(source)
    if (!provider) throw new ValidationError(`Unknown or unconfigured document source '${source}'`)
    return provider
  }

  /** Fetch a page (by id or URL) and upsert its projection; returns the document. */
  async import(
    workspaceId: string,
    source: DocumentSourceKind,
    ref: string,
  ): Promise<SourceDocument> {
    await requireWorkspace(this.deps.workspaceRepository, workspaceId)
    const provider = this.requireProvider(source)
    const externalId = provider.parseRef(ref)
    if (!externalId) {
      throw new ValidationError(`Could not resolve a ${source} page id from '${ref}'`)
    }
    const connection = await this.deps.connectionService.requireConnection(workspaceId, source)
    const content = await provider.fetchDocument(connection.credentials, externalId)

    // Preserve any existing block link across a re-import.
    const existing = await this.deps.documentRepository.get(workspaceId, source, content.externalId)
    const record: DocumentRecord = {
      workspaceId,
      source,
      externalId: content.externalId,
      title: content.title,
      url: content.url,
      excerpt: buildExcerpt(content.body),
      body: content.body,
      linkedBlockId: existing?.linkedBlockId ?? null,
      syncedAt: this.deps.clock.now(),
      deletedAt: null,
    }
    await this.deps.documentRepository.upsert(record)
    return toSourceDocument(record)
  }

  /** Every document imported into the workspace, across sources, as wire shapes. */
  async listDocuments(workspaceId: string): Promise<SourceDocument[]> {
    const records = await this.deps.documentRepository.listByWorkspace(workspaceId)
    return records.map(toSourceDocument)
  }

  /** Resolve a stored document record (with body) or throw if not imported. */
  async requireDocument(
    workspaceId: string,
    source: DocumentSourceKind,
    externalId: string,
  ): Promise<DocumentRecord> {
    const record = await this.deps.documentRepository.get(workspaceId, source, externalId)
    if (!record) {
      throw new ValidationError(`${source} page '${externalId}' has not been imported`)
    }
    return record
  }
}
