import type { Clock, IdGenerator } from '@cat-factory/kernel'
import type { DocumentSourceProvider, DocumentSourceRegistry } from '@cat-factory/kernel'
import type { DocumentRecord, DocumentRepository } from '@cat-factory/kernel'
import type { GroupCacheHandle, LinkedDocumentRefreshOutcome } from '@cat-factory/kernel'
import type { SourceDocument, DocumentSearchResult, DocumentSourceKind } from '@cat-factory/kernel'
import { contentHash, redactSecrets, ValidationError } from '@cat-factory/kernel'
import {
  orderSourcesByClaimConfidence,
  type DocumentRefReason,
  type ResolvedDocumentRef,
} from '@cat-factory/contracts'
import { requireWorkspace } from '@cat-factory/kernel'
import type { WorkspaceRepository } from '@cat-factory/kernel'
import type { DocumentConnectionService } from './DocumentConnectionService.js'
import { buildExcerpt, probeCacheKey } from './documents.logic.js'

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
  /**
   * The dispatch-time freshness cache, so a MANUAL re-import drops the document's cached verdict.
   * Deliberately invalidated by {@link DocumentImportService.import} and not by `reimport`: the
   * refresher calls `reimport` from INSIDE that cache's loader, where the entry about to be stored
   * is the fresh one and an invalidation would race the store it precedes.
   */
  versionCache?: GroupCacheHandle<LinkedDocumentRefreshOutcome>
}

/** A document body supplied directly by a caller rather than fetched from a connected source. */
export interface UploadedDocument {
  title: string
  /** The document text, as Markdown. */
  content: string
}

/**
 * The excerpt an uploaded body yields, or a refusal when it yields none.
 *
 * PURE and exported so a caller writing several uploads can validate the whole list before the
 * first write, rather than discovering the fourth one is empty with three rows already stored.
 * `ingest` calls it too, so the rule holds however the upload arrives.
 *
 * The refusal is STRICTER than the run-time one, deliberately. `hasReadableContent` passes
 * anything with a non-empty raw `body`, because a container agent opens the materialised markdown
 * and can at least see what is in it; only the excerpt-only inline readers refuse a body that
 * renders to nothing. Here the bytes are in hand and the caller can still fix them, so a document
 * that would reach HALF the readers as blank is refused for all of them rather than shipped and
 * discovered mid-run.
 */
export function assertUploadReadable(input: UploadedDocument): string {
  const excerpt = buildExcerpt(input.content)
  if (!excerpt.trim()) {
    throw new ValidationError(
      `Document '${input.title}' has no readable text, so an agent would receive an empty ` +
        `attachment. Supply the document body as Markdown or plain text.`,
    )
  }
  return excerpt
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
   * Canonicalise a pasted URL/id into the reference this source would store the page under, with
   * NO fetch, NO credential and NO write: the pure half of {@link import}, exposed on its own so
   * an attach surface can settle "is this link usable, and what does it point at" while the
   * person who pasted it still has it in front of them. Discovering it through a failed import
   * is the same verdict delivered after the task is already saved.
   *
   * The refusal is machine-readable because the two ways a paste goes wrong ask for DIFFERENT
   * corrections (see `DocumentRefReason`): text this source could never accept, versus a
   * perfectly good link aimed at the wrong source, which is fixed by switching sources with the
   * same text. The message quotes the input through `redactSecrets`, since a pasted link
   * routinely carries a `?token=` the error envelope would otherwise echo into the logs.
   *
   * A ref that parses is not automatically the ref that was MEANT: `droppedScope` carries the
   * frame/screen qualifier the provider had to discard, because a reference silently widened to
   * the whole design file is the defect this pre-flight exists to surface, and it is indetectable
   * from the resolved id alone.
   */
  resolveRef(source: DocumentSourceKind, ref: string): ResolvedDocumentRef {
    const provider = this.requireProvider(source)
    const externalId = provider.parseRef(ref)
    if (!externalId) throw this.refUnresolved(provider, source, ref)
    return {
      source,
      externalId,
      canonicalUrl: provider.canonicalUrl?.(externalId) ?? null,
      droppedScope: provider.droppedScope?.(ref, externalId) ?? null,
    }
  }

  /** The 422 for a ref this source cannot read, naming the source that CAN when one exists. */
  private refUnresolved(
    provider: DocumentSourceProvider,
    source: DocumentSourceKind,
    ref: string,
  ): ValidationError {
    const quoted = redactSecrets(ref)
    const claimedBy = this.claimingSource(source, ref)
    const expected = provider.descriptor.refPlaceholder
    return new ValidationError(
      claimedBy
        ? `'${quoted}' is a ${claimedBy} reference, not a ${source} one`
        : `Could not resolve a ${source} page id from '${quoted}'. Expected ${expected}`,
      {
        reason: claimedBy ? 'document_ref_claimed_by_other_source' : 'document_ref_unrecognized',
        source,
        ...(claimedBy ? { claimedBy } : {}),
        expected,
      } satisfies { reason: DocumentRefReason } & Record<string, unknown>,
    )
  }

  /**
   * The first OTHER configured source whose `parseRef` recognises this input, or undefined.
   *
   * The ordering is `orderSourcesByClaimConfidence`, the same function `makeDocumentUrlResolver`
   * reads rather than a second copy of its two passes: a blind parser claims a SHAPE (any
   * UUID-shaped run, any `/pages/<digits>` segment), so letting registration order decide would
   * have this hint point a Figma paste at Notion.
   */
  private claimingSource(exclude: DocumentSourceKind, ref: string): DocumentSourceKind | undefined {
    const candidates = this.deps.registry.list().filter((p) => p.kind !== exclude)
    return orderSourcesByClaimConfidence(candidates).find((p) => p.parseRef(ref))?.kind
  }

  /**
   * Fetch a page (by id or URL) and upsert its projection; returns the document. The
   * provider authenticates with the workspace's stored credential.
   *
   * The workspace guard is {@link reimport}'s, which this delegates to: one guard on the write
   * itself rather than one per entry point, so a caller cannot reach the upsert around it. What
   * runs first here is only {@link resolveRef}'s PURE validation (is the source wired, does the
   * ref yield an id), which touches nothing, and it goes through that method rather than
   * re-parsing here, so the attach surface's pre-flight and the import cannot disagree about
   * which refs are usable.
   */
  async import(
    workspaceId: string,
    source: DocumentSourceKind,
    ref: string,
  ): Promise<SourceDocument> {
    const { externalId } = this.resolveRef(source, ref)
    const record = await this.reimport(workspaceId, source, externalId)
    // A human just pulled this page fresh. The cached freshness verdict was reached against the
    // token the row carried BEFORE this write, so leaving it would make the next dispatch compare a
    // fresh row against a stale answer: either a needless re-download or a `confirmed` naming the
    // wrong revision.
    await this.deps.versionCache?.invalidate(probeCacheKey(source, record.externalId), workspaceId)
    return toSourceDocument(record)
  }

  /**
   * Re-fetch an ALREADY-resolved page id and upsert its projection, returning the stored record.
   *
   * The body of {@link import} minus the ref parsing, split out for the dispatch-time refresh
   * (`LinkedDocumentRefreshService`), which starts from a stored row and therefore already holds the
   * canonical external id. Round-tripping that id back through `parseRef` to reach `import` would
   * put the ONE hop that can legitimately fail — turning user input into an id — on a path where
   * there is no user input, so a provider whose bare-id branch is stricter than its URL branch would
   * refuse to refresh a document it had happily imported.
   *
   * `fallbackVersion` is the token to record when the source's own fetch exposes none, and it is
   * what makes the dispatch-time ladder CONVERGE. A provider may resolve its version best-effort
   * inside `fetchDocument` (GitHub docs' commit sha degrades to `null` on a rate-limited request)
   * while its cheap `probeVersion` still answers, and the refresh compares the two: a row left
   * holding `null` mismatches the probe on every future dispatch, so the whole document is
   * re-downloaded forever and the freshness note reports `unversioned` about a source that plainly
   * exposes a version. Recording what the caller just probed is also the CONSERVATIVE direction:
   * the body is at least as new as that token, so a later edit still moves the probe past it.
   */
  async reimport(
    workspaceId: string,
    source: DocumentSourceKind,
    externalId: string,
    opts: { fallbackVersion?: string } = {},
  ): Promise<DocumentRecord> {
    // The class invariant every other write on this service holds: no `documents` row is ever
    // written for a workspace that does not exist. It sits on the method that WRITES rather than on
    // each entry point, so a caller cannot reach the upsert around it.
    await requireWorkspace(this.deps.workspaceRepository, workspaceId)
    const provider = this.requireProvider(source)
    const connection = await this.deps.connectionService.requireConnection(workspaceId, source)
    const content = await provider.fetchDocument(connection.credentials, externalId, workspaceId)
    const version = content.version || opts.fallbackVersion || null

    // Preserve any existing block link across a re-import.
    const existing = await this.deps.documentRepository.get(workspaceId, source, content.externalId)
    const hash = contentHash(content.body)
    // Idempotent re-import: skip the write only when NOTHING that reaches an agent has
    // changed — the body (by hash) AND the title/url metadata (which feed the prompt's
    // summary index and the materialised file's `Source:` header). A renamed/moved page
    // whose body is unchanged still re-projects so the stale title/url don't linger.
    //
    // `sourceVersion` is part of that comparison even though no agent reads it, because it is what
    // the refresh COMPARES: a page whose version bumped without changing a byte of its Markdown (a
    // Figma file version moves on any edit in the file, including a frame this document doesn't
    // cover) would otherwise keep the old token on the row and be re-fetched on every single
    // dispatch forever, which is the cost the version probe exists to avoid.
    if (
      existing &&
      existing.deletedAt === null &&
      existing.contentHash === hash &&
      existing.title === content.title &&
      existing.url === content.url &&
      existing.sourceVersion === version
    ) {
      return existing
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
      // NULL rather than `''` for a source that exposes no version, so "not versioned" is one value
      // everywhere instead of two the refresh would have to test for separately.
      sourceVersion: version,
      linkedBlockId: existing?.linkedBlockId ?? null,
      // Role links (template/exemplar) are owned by the link write path, not import — preserve
      // any existing tag across a re-import (the repo's upsert also leaves these columns alone).
      role: existing?.role ?? null,
      docKind: existing?.docKind ?? null,
      syncedAt: this.deps.clock.now(),
      deletedAt: null,
    }
    await this.deps.documentRepository.upsert(record)
    return record
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
   * REFUSES text that yields no readable excerpt, through {@link assertUploadReadable} — which a
   * caller sequencing several uploads calls FIRST, on its own, so nothing is written until the
   * whole list is known to be good. See its own note for what that refusal is and is not.
   */
  async ingest(workspaceId: string, input: UploadedDocument): Promise<SourceDocument> {
    await requireWorkspace(this.deps.workspaceRepository, workspaceId)
    const excerpt = assertUploadReadable(input)
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
      // No source, so no version: nothing can ever re-probe this body, which is the same fact
      // `source: 'upload'` states one field over.
      sourceVersion: null,
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
