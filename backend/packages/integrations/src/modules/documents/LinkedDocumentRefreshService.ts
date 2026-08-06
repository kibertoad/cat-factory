import type {
  DocumentFreshness,
  DocumentFreshnessGap,
  DocumentRecord,
  DocumentSourceKind,
  DocumentSourceRegistry,
  GroupCacheHandle,
  LinkedDocumentRefresher,
  Logger,
  RefreshedDocument,
} from '@cat-factory/kernel'
import { describeError, noopLogger } from '@cat-factory/kernel'
import { isConnectableSource } from '@cat-factory/contracts'
import type { DocumentConnectionService } from './DocumentConnectionService.js'
import type { DocumentImportService } from './DocumentImportService.js'

// LinkedDocumentRefreshService: the {@link LinkedDocumentRefresher} implementation — the
// dispatch-time half of document freshness.
//
// Before this, a linked document was frozen at import time: the projection was written once and no
// later reader looked at the source again, so a run started after the page moved fed its agent the
// old copy with nothing anywhere saying so. This runs on the resolution path of every dispatch and
// answers, per document, "is the body we are about to hand an agent the current one".
//
// THE COST MODEL IS THE DESIGN. A dispatch happens per STEP, so a naive "re-fetch each linked
// document" would re-download every attached page a dozen times per run — and a whole-file Figma
// import fans out into chunked per-frame node reads, so that is the expensive direction. So the
// check is a two-level ladder:
//
//   1. the CHEAP probe (`probeVersion`: Figma's `?depth=1`, Confluence's version field), served
//      through the app cache seam so a burst of step dispatches costs ONE probe per document; then
//   2. a full re-import ONLY when the probed token differs from the one the stored row was imported
//      at (`DocumentRecord.sourceVersion`).
//
// Which is why the row records its version at all: without it, "unchanged" is unprovable and every
// dispatch pays the download.

/** The value cached per document: the source's version token as of the last probe. */
interface ProbedVersion {
  readonly version: string
}

/**
 * Sentinel for "the connection READ itself failed", distinct from the `null` that means "there is
 * definitely no connection". A sentinel rather than a rethrow because the two land on different
 * `DocumentFreshnessGap`s and the caller must not have to tell them apart by inspecting an error.
 */
const CONNECTION_UNREADABLE = Symbol('connection-unreadable')

export interface LinkedDocumentRefreshServiceDependencies {
  registry: DocumentSourceRegistry
  connectionService: DocumentConnectionService
  /** Writes the fresh projection when a page has moved (`reimport`). */
  importService: DocumentImportService
  /**
   * The short-TTL probe cache (`AppCaches.linkedDocumentVersion`). Optional so the service is
   * unit-testable standalone and so a deployment with pass-through caching still refreshes — it just
   * probes once per dispatch instead of once per TTL window.
   */
  versionCache?: GroupCacheHandle<ProbedVersion>
  logger?: Logger
}

export class LinkedDocumentRefreshService implements LinkedDocumentRefresher {
  private readonly log: Logger

  constructor(private readonly deps: LinkedDocumentRefreshServiceDependencies) {
    this.log = deps.logger ?? noopLogger
  }

  /**
   * Confirm every document CONCURRENTLY, returning one verdict per input in the same order.
   *
   * Concurrent because each document is a different external page on a different host: there is no
   * batch a provider could offer, so the fan-out is inherent rather than an N+1 to collapse (the
   * repository reads inside a re-import are per-document by nature too — a fetch and its own upsert).
   * A task attaches a handful of documents, so the fan-out is small and bounded by the same corpus
   * budget that already refuses an oversized one.
   */
  async refresh(
    workspaceId: string,
    documents: readonly DocumentRecord[],
  ): Promise<readonly RefreshedDocument[]> {
    return Promise.all(documents.map((record) => this.refreshOne(workspaceId, record)))
  }

  /**
   * One document's verdict. NEVER throws (the port's best-effort contract): a source outage costs the
   * run a stale body and a stated warning, never the run.
   */
  private async refreshOne(
    workspaceId: string,
    record: DocumentRecord,
  ): Promise<RefreshedDocument> {
    // An `upload` has no provider to ask, and a source this deployment never wired has no provider
    // either. Both are "nothing fresher exists to compare against", which is NOT a degradation —
    // distinct from the gaps below, which are.
    if (!isConnectableSource(record.source)) return notApplicable(record)
    const source = record.source
    if (!this.deps.registry.get(source)) return notApplicable(record)
    try {
      return await this.confirm(workspaceId, source, record)
    } catch (error) {
      // Bespoke rather than `runBestEffort` because the swallow has to produce a VALUE: the caller
      // needs the stored record plus the reason, so there is nothing to return `undefined` for. The
      // cause is bound the same way `runBestEffort` binds it, so the log line is identical.
      this.log.warn('linked document could not be confirmed against its source', {
        workspaceId,
        source,
        externalId: record.externalId,
        ...describeError(error),
      })
      return unconfirmed(record, 'source_unreachable')
    }
  }

  /** The probe → compare → re-import ladder for a source-backed document. */
  private async confirm(
    workspaceId: string,
    source: DocumentSourceKind,
    record: DocumentRecord,
  ): Promise<RefreshedDocument> {
    // Checked BEFORE the probe, and with its OWN failure disposition, so three different facts stay
    // three different notes. A definite "no connection" is the workspace's to fix; a connection read
    // that THROWS is the deployment's, and it is a real permanent state rather than a defensive
    // branch: on a mothership-mode node the document-connection repository is db-direct over an
    // absent `db` handle (its rows are sealed with the mothership's key, so they cannot be served
    // over the persistence RPC), so this read always fails there. Folding it into the catch below
    // would tell every such run that Figma is down.
    const connection = await this.deps.connectionService
      .getConnection(workspaceId, source)
      .catch((error: unknown) => {
        this.log.warn('linked document freshness: source credentials could not be read', {
          workspaceId,
          source,
          ...describeError(error),
        })
        return CONNECTION_UNREADABLE
      })
    if (connection === CONNECTION_UNREADABLE) {
      return unconfirmed(record, 'credentials_unreadable')
    }
    if (!connection) return unconfirmed(record, 'not_connected')

    const probed = await this.probe(workspaceId, source, record.externalId)
    // The source answered but has no version to compare. Not an error and not fixable — but the copy
    // still cannot be called confirmed, and claiming otherwise is the one lie this feature must not
    // tell (see `DocumentFreshnessGap`).
    if (!probed) return unconfirmed(record, 'unversioned')
    if (probed === record.sourceVersion) {
      return { record, freshness: { status: 'confirmed', version: probed, reimported: false } }
    }

    // The page moved (or the row predates version recording, which is the same "cannot prove it is
    // current" and self-heals on this one re-import). `reimport` is idempotent, preserves the block
    // link and the role tag, and skips the write when only the version token moved.
    const refreshed = await this.deps.importService.reimport(workspaceId, source, record.externalId)
    this.log.debug('linked document re-imported at dispatch', {
      workspaceId,
      source,
      externalId: record.externalId,
    })
    // The version of the body ACTUALLY STORED, read off the written row rather than reusing the
    // probed token: the fetch that followed the probe can legitimately land a newer revision than
    // the probe saw, and stating the probe's token would name a revision the agent is not reading.
    return {
      record: refreshed,
      freshness: refreshed.sourceVersion
        ? { status: 'confirmed', version: refreshed.sourceVersion, reimported: true }
        : // A source whose fetch returns no version after a probe that did: nothing to state, and
          // the body is as fresh as it can be, so report the gap rather than a blank revision.
          { status: 'unconfirmed', reason: 'unversioned' },
    }
  }

  /**
   * The source's current version token, through the short-TTL cache so a run's many step dispatches
   * cost one probe rather than one each. `''` when the source exposes none.
   */
  private async probe(
    workspaceId: string,
    source: DocumentSourceKind,
    externalId: string,
  ): Promise<string> {
    const load = async (): Promise<ProbedVersion> => {
      const provider = this.deps.registry.get(source)
      if (!provider) return { version: '' }
      const connection = await this.deps.connectionService.requireConnection(workspaceId, source)
      return {
        version: await provider.probeVersion(connection.credentials, externalId, workspaceId),
      }
    }
    if (!this.deps.versionCache) return (await load()).version
    // Grouped by workspace so a workspace's connection change can drop every probe it authorised in
    // one call, and keyed per document within it — the same shape as the fragment body cache.
    const cached = await this.deps.versionCache.get(
      probeCacheKey(source, externalId),
      workspaceId,
      load,
    )
    return cached.version
  }
}

/** The probe cache key: one entry per source document, within a workspace group. */
export function probeCacheKey(source: DocumentSourceKind, externalId: string): string {
  return `${source}:${externalId}`
}

function notApplicable(record: DocumentRecord): RefreshedDocument {
  return { record, freshness: { status: 'not-applicable' } }
}

function unconfirmed(record: DocumentRecord, reason: DocumentFreshnessGap): RefreshedDocument {
  const freshness: DocumentFreshness = { status: 'unconfirmed', reason }
  return { record, freshness }
}
