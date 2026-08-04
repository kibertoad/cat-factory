import type { Clock, IdGenerator } from '@cat-factory/kernel'
import type { DocumentSourceRegistry } from '@cat-factory/kernel'
import type { DocumentRecord, DocumentRepository } from '@cat-factory/kernel'
import type { SourceDocument, DocumentSearchResult, DocumentSourceKind } from '@cat-factory/kernel'
import { contentHash, ValidationError } from '@cat-factory/kernel'
import { requireWorkspace } from '@cat-factory/kernel'
import type { WorkspaceRepository } from '@cat-factory/kernel'
import type { DocumentConnectionService } from './DocumentConnectionService.js'
import { buildExcerpt } from './documents.logic.js'

// DocumentImportService: gets a document's text into the workspace's local projection, from
// either direction. `import` FETCHES a page from a connected source (ref parsing and fetching
// delegated to that source's provider); `ingest` takes a body the caller already holds. Both
// land the same row, because the cached body is what the planner (doc → board structure) and the
// agent-context injection read, so either is the prerequisite for spawning structure or linking
// context.

export interface DocumentImportServiceDependencies {
  registry: DocumentSourceRegistry
  documentRepository: DocumentRepository
  connectionService: DocumentConnectionService
  workspaceRepository: WorkspaceRepository
  clock: Clock
  /** Mints the external id an `ingest`ed document is keyed by (it has no source id of its own). */
  idGenerator: IdGenerator
}

/** A document body supplied directly by a caller rather than fetched from a connected source. */
export interface UploadedDocument {
  title: string
  /** The document text, as Markdown. */
  content: string
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
    role: record.role,
    docKind: record.docKind,
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
   * Fetch a page (by id or URL) and upsert its projection; returns the document. The
   * provider authenticates with the workspace's stored credential.
   */
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
    const content = await provider.fetchDocument(connection.credentials, externalId, workspaceId)

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
      // Role links (template/exemplar) are owned by the link write path, not import — preserve
      // any existing tag across a re-import (the repo's upsert also leaves these columns alone).
      role: existing?.role ?? null,
      docKind: existing?.docKind ?? null,
      syncedAt: this.deps.clock.now(),
      deletedAt: null,
    }
    await this.deps.documentRepository.upsert(record)
    return toSourceDocument(record)
  }

  /**
   * Persist a document body the caller supplied directly, as an `upload`-origin projection.
   *
   * The same row shape `import` writes, so everything downstream (the block link, the
   * linked-context resolution, the `.cat-context/` materialisation, the corpus budget) works on
   * it without knowing where the text came from. What it does NOT have is a provider: nothing can
   * re-fetch it, re-probe it for a fresher version, or link back to a page, which is exactly why
   * `upload` is a {@link DocumentOrigin} and not a {@link DocumentSourceKind}.
   *
   * The external id is MINTED rather than derived from the content. A content-addressed id would
   * make two tasks uploading the same spec collide on the primary key, and since a document row
   * carries a single `linkedBlockId` the second upload would silently steal the first task's
   * attachment. Each upload is its own document.
   *
   * REFUSES text that yields no readable excerpt (a body that is pure markup collapses to nothing
   * through `markdownToText`). The platform already refuses such a document, but at the first step
   * that resolves context, deep inside a run the caller has by then started and paid for. Here the
   * body is in hand and the caller can fix it, so the refusal belongs at the boundary.
   */
  async ingest(workspaceId: string, input: UploadedDocument): Promise<SourceDocument> {
    await requireWorkspace(this.deps.workspaceRepository, workspaceId)
    const excerpt = buildExcerpt(input.content)
    if (!excerpt.trim()) {
      throw new ValidationError(
        `Document '${input.title}' has no readable text, so an agent would receive an empty ` +
          `attachment. Supply the document body as Markdown or plain text.`,
      )
    }
    const record: DocumentRecord = {
      workspaceId,
      source: 'upload',
      externalId: this.deps.idGenerator.next('doc'),
      title: input.title,
      // No page to link back to. Empty rather than a synthesised URL: readers render the origin
      // only when there is one (see `sourceDocumentSchema.url`), and a fabricated link would send
      // a human chasing a page that does not exist.
      url: '',
      excerpt,
      body: input.content,
      contentHash: contentHash(input.content),
      linkedBlockId: null,
      role: null,
      docKind: null,
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
  ): Promise<DocumentSearchResult[]> {
    await requireWorkspace(this.deps.workspaceRepository, workspaceId)
    const provider = this.requireProvider(source)
    if (!provider.search) {
      throw new ValidationError(`The ${source} source does not support search`)
    }
    const connection = await this.deps.connectionService.requireConnection(workspaceId, source)
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
