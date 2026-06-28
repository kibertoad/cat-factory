import type { Clock } from '@cat-factory/kernel'
import type { DocumentSourceRegistry } from '@cat-factory/kernel'
import type { DocumentRecord, DocumentRepository } from '@cat-factory/kernel'
import type { SourceDocument, DocumentSearchResult, DocumentSourceKind } from '@cat-factory/kernel'
import { contentHash, ValidationError } from '@cat-factory/kernel'
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

  /**
   * Fetch a page (by id or URL) and upsert its projection; returns the document.
   * `ownerUserId` resolves the credential for a personal (`credentialScope: 'user'`)
   * source — the acting user — and is ignored for workspace sources. The cached
   * projection is always workspace-scoped, so a personal source's imported page is
   * shared with the workspace once fetched (only the *credential* is personal).
   */
  async import(
    workspaceId: string,
    source: DocumentSourceKind,
    ref: string,
    ownerUserId = '',
  ): Promise<SourceDocument> {
    await requireWorkspace(this.deps.workspaceRepository, workspaceId)
    const provider = this.requireProvider(source)
    const externalId = provider.parseRef(ref)
    if (!externalId) {
      throw new ValidationError(`Could not resolve a ${source} page id from '${ref}'`)
    }
    const connection = await this.deps.connectionService.requireConnection(
      workspaceId,
      source,
      ownerUserId,
    )
    const content = await provider.fetchDocument(connection.credentials, externalId)

    // Preserve any existing block link across a re-import.
    const existing = await this.deps.documentRepository.get(workspaceId, source, content.externalId)
    const hash = contentHash(content.body)
    // Idempotent re-import: skip the write only when NOTHING that reaches an agent has
    // changed — the body (by hash) AND the title/url metadata (which feed the prompt's
    // summary index and the materialised file's `Source:` header). A renamed/moved page
    // whose body is unchanged still re-projects so the stale title/url don't linger.
    if (
      existing &&
      existing.deletedAt === null &&
      existing.contentHash === hash &&
      existing.title === content.title &&
      existing.url === content.url
    ) {
      return toSourceDocument(existing)
    }
    const record: DocumentRecord = {
      workspaceId,
      source,
      externalId: content.externalId,
      title: content.title,
      url: content.url,
      excerpt: buildExcerpt(content.body),
      body: content.body,
      contentHash: hash,
      linkedBlockId: existing?.linkedBlockId ?? null,
      syncedAt: this.deps.clock.now(),
      deletedAt: null,
    }
    await this.deps.documentRepository.upsert(record)
    return toSourceDocument(record)
  }

  /**
   * Search a source's catalogue by free text, returning lean hits (not yet
   * imported). The provider authenticates with the workspace's stored credentials
   * and builds/parses the source-specific query. Throws if the source can't
   * search (no provider `search`), so the controller can answer cleanly.
   */
  async search(
    workspaceId: string,
    source: DocumentSourceKind,
    query: string,
    ownerUserId = '',
  ): Promise<DocumentSearchResult[]> {
    await requireWorkspace(this.deps.workspaceRepository, workspaceId)
    const provider = this.requireProvider(source)
    if (!provider.search) {
      throw new ValidationError(`The ${source} source does not support search`)
    }
    const connection = await this.deps.connectionService.requireConnection(
      workspaceId,
      source,
      ownerUserId,
    )
    return provider.search(connection.credentials, query, workspaceId)
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
