import type {
  DocumentConnectionRecord,
  DocumentFreshness,
  DocumentFreshnessGap,
  DocumentRecord,
  DocumentSourceKind,
  DocumentSourceProvider,
  DocumentSourceRegistry,
  GroupCacheHandle,
  LinkedDocumentRefreshOutcome,
  LinkedDocumentRefresher,
  Logger,
  OperationalMetrics,
  RefreshedDocument,
} from '@cat-factory/kernel'
import { describeError, noopLogger, noopOperationalMetrics } from '@cat-factory/kernel'
import { isConnectableSource, type RefreshedDocumentView } from '@cat-factory/contracts'
import pMap from 'p-map'
import type { DocumentConnectionService } from './DocumentConnectionService.js'
import { type DocumentImportService, toSourceDocument } from './DocumentImportService.js'
import { probeCacheKey, sameAgentVisibleProjection } from './documents.logic.js'

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
// import fans out into chunked per-frame node reads, so that is the expensive direction. Three
// things bound it, and each of them bounds a different half:
//
//   1. the CHEAP probe (`probeVersion`: Figma's `?depth=1`, Confluence's version field) decides
//      whether anything needs downloading at all, by comparing against the token the stored row was
//      imported at (`DocumentRecord.sourceVersion`), which is why the row records its version at
//      all: without it, "unchanged" is unprovable and every dispatch pays the download;
//   2. the app cache holds the OUTCOME of that whole ladder, re-import included, so a burst of step
//      dispatches costs ONE round trip to the source per document, concurrent dispatches of the
//      same document dedupe onto one download, and a source that is DOWN is remembered as down
//      instead of being asked again by every dispatch for as long as the outage lasts;
//   3. the fan-out across a corpus is bounded, and the workspace's connection is resolved ONCE for
//      the whole pass rather than per document.

/** How many documents of one corpus are asked about at a time. */
const REFRESH_CONCURRENCY = 4

/**
 * Why a pass is running. Not bookkeeping: it is the ONE thing the two entry points disagree about,
 * and both disagreements are consequences of the same fact, that a `dispatch` is about to hand a
 * body to an AGENT while a `manual` check is a person asking a question.
 *
 *  - a gap is COUNTED only for a dispatch, because `document.freshness_gap` measures runs reading
 *    a copy the source has moved past. A click hands nothing to anyone;
 *  - a failure is REMEMBERED in the shared cache only for a dispatch (see {@link runLadder}).
 *
 * Threaded rather than held per-entry-point because every step of the ladder below is shared, and a
 * second code path would be a second place for the ladder itself to drift.
 */
type RefreshTrigger = 'dispatch' | 'manual'

/**
 * Sentinel for "the connection READ itself failed", distinct from the `null` that means "there is
 * definitely no connection". A sentinel rather than a rethrow because the two land on different
 * `DocumentFreshnessGap`s and the caller must not have to tell them apart by inspecting an error.
 */
const CONNECTION_UNREADABLE = Symbol('connection-unreadable')

/** What the pass resolved for one source: a live connection, no connection, or an unreadable read. */
type ResolvedConnection = DocumentConnectionRecord | null | typeof CONNECTION_UNREADABLE

export interface LinkedDocumentRefreshServiceDependencies {
  registry: DocumentSourceRegistry
  connectionService: DocumentConnectionService
  /** Writes the fresh projection when a page has moved (`reimport`). */
  importService: DocumentImportService
  /**
   * The short-TTL freshness cache (`AppCaches.linkedDocumentVersion`). Optional so the service is
   * unit-testable standalone and so a deployment with pass-through caching still refreshes — it just
   * asks the source once per dispatch instead of once per TTL window.
   */
  versionCache?: GroupCacheHandle<LinkedDocumentRefreshOutcome>
  logger?: Logger
  /** Counts the gaps; see the `document.freshness_gap` counter for why a log line is not enough. */
  metrics?: OperationalMetrics
}

export class LinkedDocumentRefreshService implements LinkedDocumentRefresher {
  private readonly log: Logger
  private readonly metrics: OperationalMetrics

  constructor(private readonly deps: LinkedDocumentRefreshServiceDependencies) {
    this.log = deps.logger ?? noopLogger
    this.metrics = deps.metrics ?? noopOperationalMetrics
  }

  /**
   * Confirm every document, returning one verdict per input in the same order.
   *
   * The per-document work is inherently per-document (each is a different external page on a
   * different host, and no provider offers a batch), so it fans out, but BOUNDED: a task may attach
   * up to the corpus budget's worth of Figma frames, and an unbounded fan-out turns one dispatch
   * into that many concurrent whole-file imports, which is how a rate limit gets sustained for a
   * whole run rather than ridden out.
   *
   * What is NOT per-document is the workspace's connection to a source: it is invariant for the
   * entire pass, so it is resolved once per distinct source in a single read (`resolveConnections`)
   * and handed down, rather than re-read per document and then again inside each probe.
   */
  async refresh(
    workspaceId: string,
    documents: readonly DocumentRecord[],
  ): Promise<readonly RefreshedDocument[]> {
    const connections = await this.resolveConnections(workspaceId, documents)
    return pMap(
      documents,
      (record) => this.refreshOne(workspaceId, record, connections, 'dispatch'),
      { concurrency: REFRESH_CONCURRENCY },
    )
  }

  /**
   * Confirm ONE stored document because a PERSON asked, not because a dispatch did.
   *
   * Same ladder, run under the `manual` trigger. The cached verdict is dropped first: the cache
   * exists so a burst of step dispatches costs one round trip, and it deliberately remembers a
   * failure so an outage is not re-probed by every dispatch. Both are exactly wrong for a human
   * clicking Refresh: the click IS the request for a new answer, and the most common reason to
   * click is that the last answer said the source was unreachable, so a refresh served from that
   * cache would report the very outage the person is retrying past.
   *
   * A SUCCESSFUL outcome is still stored, so the dispatches that follow a manual refresh inherit it
   * rather than re-asking the source. A failed one is not, which is the asymmetry {@link runLadder}
   * exists to hold: dropping the entry and then re-filling it with whatever one click found would
   * let a person retrying past a flaky source install an `unreachable` verdict that every dispatch
   * for the next TTL window reads, degrading the run path with a failure no dispatch observed.
   */
  async refreshNow(
    workspaceId: string,
    source: DocumentSourceKind,
    externalId: string,
  ): Promise<RefreshedDocumentView> {
    const stored = await this.deps.importService.requireDocument(workspaceId, source, externalId)
    await this.deps.versionCache?.invalidate(probeCacheKey(source, externalId), workspaceId)
    const connections = await this.resolveConnections(workspaceId, [stored])
    const { record, freshness } = await this.refreshOne(workspaceId, stored, connections, 'manual')
    // BOTH halves, because neither answers alone: the row carries the title/excerpt/`syncedAt` the
    // caller re-renders, and only the verdict says whether it was confirmed current. An unchanged
    // row under a `confirmed` verdict and the same row under an `unconfirmed` one are identical
    // bytes and opposite facts.
    return { document: toSourceDocument(record), freshness }
  }

  /**
   * The live connection per source this corpus actually needs, in ONE read.
   *
   * Its own failure disposition, so three different facts stay three different notes. A definite
   * "no connection" is the workspace's to fix; a read that THROWS is the deployment's, and it is a
   * real permanent state rather than a defensive branch: on a mothership-mode node the
   * document-connection repository is db-direct over an absent `db` handle (its rows are sealed with
   * the mothership's key, so they cannot be served over the persistence RPC), so this read always
   * fails there. Folding it into the per-document catch would tell every such run that Figma is down.
   */
  private async resolveConnections(
    workspaceId: string,
    documents: readonly DocumentRecord[],
  ): Promise<Map<DocumentSourceKind, ResolvedConnection>> {
    const sources = [
      ...new Set(
        documents
          .map((record) => record.source)
          .filter((source): source is DocumentSourceKind => isConnectableSource(source))
          .filter((source) => this.deps.registry.get(source)),
      ),
    ]
    try {
      return new Map<DocumentSourceKind, ResolvedConnection>(
        await this.deps.connectionService.resolveConnections(workspaceId, sources),
      )
    } catch (error) {
      // INFO, not `warn`. In mothership mode this fails permanently and BY DESIGN, on every
      // dispatch of every run, with no remedy anyone intends to apply, and a warning that repeats
      // forever is how a channel gets tuned out (the same call `reportUnmatchedUrls` makes one
      // layer up). The `document.freshness_gap` counter, incremented per affected document below,
      // is what answers whether this is rising.
      this.log.info('linked document freshness: source credentials could not be read', {
        workspaceId,
        ...describeError(error),
      })
      return new Map(sources.map((source) => [source, CONNECTION_UNREADABLE]))
    }
  }

  /**
   * One document's verdict. NEVER throws (the port's best-effort contract): a source outage costs the
   * run a stale body and a stated warning, never the run.
   */
  private async refreshOne(
    workspaceId: string,
    record: DocumentRecord,
    connections: Map<DocumentSourceKind, ResolvedConnection>,
    trigger: RefreshTrigger,
  ): Promise<RefreshedDocument> {
    const refreshed = await this.verdictFor(workspaceId, record, connections, trigger)
    // ONE increment site for every gap, whichever branch produced it, so the rate cannot drift from
    // the verdicts actually rendered. Both dimensions are closed vocabularies.
    //
    // DISPATCHES ONLY, and that is the counter's contract rather than a sampling shortcut: it counts
    // runs that read a copy the source has moved past. A person clicking Refresh hands no body to
    // any agent, and the commonest reason to click is that the source was down a moment ago, so
    // counting the click would let one person retrying an outage move a deployment-wide rate as far
    // as they have patience for, in the exact direction that reads as "agents are being handed more
    // stale designs than they were". The click is not invisible: it is logged like every other pass,
    // with its `trigger`.
    if (trigger === 'dispatch' && refreshed.freshness.status === 'unconfirmed') {
      this.metrics.increment('document.freshness_gap', {
        reason: refreshed.freshness.reason,
        source: record.source,
      })
    }
    return refreshed
  }

  private async verdictFor(
    workspaceId: string,
    record: DocumentRecord,
    connections: Map<DocumentSourceKind, ResolvedConnection>,
    trigger: RefreshTrigger,
  ): Promise<RefreshedDocument> {
    // An `upload` has no provider to ask, and a source this deployment never wired has no provider
    // either. Both are "nothing fresher exists to compare against", which is NOT a degradation —
    // distinct from the gaps below, which are.
    if (!isConnectableSource(record.source)) return notApplicable(record)
    const source = record.source
    const provider = this.deps.registry.get(source)
    if (!provider) return notApplicable(record)
    const connection = connections.get(source)
    if (connection === CONNECTION_UNREADABLE) return unconfirmed(record, 'credentials_unreadable')
    if (!connection) return unconfirmed(record, 'not_connected')
    try {
      return await this.confirm(workspaceId, source, provider, connection, record, trigger)
    } catch (error) {
      // The ladder catches its own failures inside the cache loader (so they are REMEMBERED rather
      // than retried per dispatch); this covers what is left, above all the local re-read below.
      // Bespoke rather than `runBestEffort` because the swallow has to produce a VALUE: the caller
      // needs the stored record plus the reason, so there is nothing to return `undefined` for.
      this.log.warn('linked document freshness: the refreshed copy could not be read back', {
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
    provider: DocumentSourceProvider,
    connection: DocumentConnectionRecord,
    record: DocumentRecord,
    trigger: RefreshTrigger,
  ): Promise<RefreshedDocument> {
    // Set by the ladder when THIS call ran the re-import; left undefined on a cache HIT, where the
    // download already happened (on an earlier dispatch, or on a concurrent one this call deduped
    // onto) and the row we were handed may not carry it yet.
    let reimported: DocumentRecord | undefined
    const outcome = await this.attempt(
      workspaceId,
      source,
      record.externalId,
      trigger,
      async () => {
        const probed = await provider.probeVersion(
          connection.credentials,
          record.externalId,
          workspaceId,
        )
        // The source answered but has no version to compare. Not an error and not fixable, but the
        // copy still cannot be called confirmed, and claiming otherwise is the one lie this feature
        // must not tell (see `DocumentFreshnessGap`).
        if (!probed) return { status: 'unversioned' }
        if (probed === record.sourceVersion) return { status: 'versioned', version: probed }
        // The page moved (or the row predates version recording, which is the same "cannot prove it is
        // current" and self-heals on this one re-import). `reimport` is idempotent, preserves the block
        // link and the role tag, and skips the write when only the version token moved.
        reimported = await this.deps.importService.reimport(
          workspaceId,
          source,
          record.externalId,
          {
            fallbackVersion: probed,
          },
        )
        this.log.debug('linked document re-imported', {
          workspaceId,
          source,
          externalId: record.externalId,
          trigger,
        })
        // The version of the body ACTUALLY STORED, read off the written row rather than reusing the
        // probed token: the fetch that followed the probe can legitimately land a newer revision than
        // the probe saw, and stating the probe's token would name a revision the agent is not reading.
        // `?? probed` is total rather than defensive (`fallbackVersion` guarantees the row carries a
        // token), and it is what keeps this from re-downloading the same document forever.
        return { status: 'versioned', version: reimported.sourceVersion ?? probed }
      },
    )

    if (outcome.status === 'unreachable') return unconfirmed(record, 'source_unreachable')
    if (outcome.status === 'unversioned') return unconfirmed(record, 'unversioned')
    // The row this pass was handed already carries the token the source last answered with, so
    // nothing was fetched and nothing was written.
    if (record.sourceVersion === outcome.version) {
      return {
        record,
        freshness: { status: 'confirmed', version: outcome.version, change: 'unchanged' },
      }
    }
    // It does not, so the source has moved past the token in hand: either this call just re-imported
    // it, or a concurrent dispatch did and this call deduped onto its cached outcome, in which case
    // the row moved AFTER our corpus read. Re-read it rather than labelling a stale body with a
    // fresh revision, which is the exact lie the whole feature exists to prevent.
    const current =
      reimported ??
      (await this.deps.importService.requireDocument(workspaceId, source, record.externalId))
    // A MOVED TOKEN IS NOT A CHANGED DOCUMENT, and collapsing the two is the same class of lie in
    // the other direction. A Figma file's version bumps on any edit anywhere in it, so the common
    // case for a document covering one frame is that the token moved and not one byte a reader sees
    // did. Calling that `reimported` would tell a person their design had been pulled in when their
    // own edit may be in a frame nothing here covers. The comparison is `reimport`'s own
    // ("what reaches an agent"), shared rather than restated so the two cannot disagree.
    return {
      record: current,
      freshness: {
        status: 'confirmed',
        version: current.sourceVersion ?? outcome.version,
        change: sameAgentVisibleProjection(record, current) ? 'revision_only' : 'reimported',
      },
    }
  }

  /**
   * Run the ladder, turning ANY failure into the `unreachable` outcome the caller can render.
   *
   * Whether that failure is also REMEMBERED by the shared cache is {@link runLadder}'s call, so this
   * stays the one place a failure becomes a verdict however it got here.
   */
  private async attempt(
    workspaceId: string,
    source: DocumentSourceKind,
    externalId: string,
    trigger: RefreshTrigger,
    ladder: () => Promise<LinkedDocumentRefreshOutcome>,
  ): Promise<LinkedDocumentRefreshOutcome> {
    try {
      return await this.runLadder(workspaceId, source, externalId, trigger, ladder)
    } catch (error) {
      // A `manual` pass routes its failures here BY DESIGN (its loader rethrows, so the cache stores
      // nothing); a `dispatch` reaches it only if the cache handle itself failed. Bespoke rather
      // than `runBestEffort` because the swallow has to produce a VALUE: the caller needs a verdict,
      // so there is nothing to return `undefined` for.
      return this.unreachable(workspaceId, source, externalId, trigger, error)
    }
  }

  /**
   * The ladder under the short-TTL cache, with the trigger's failure rule applied. The rule is
   * ASYMMETRIC, and each half is load-bearing.
   *
   * A DISPATCH's failure is REMEMBERED: its loader catches and returns `unreachable` as a value, so
   * the cache stores it. A loader that throws caches nothing, and without this a rate-limited or
   * unreachable source would be re-asked (and its changed documents re-downloaded) by every step
   * dispatch for as long as it stayed down. Remembering it bounds an outage to one probe per TTL
   * window, at a cost of at most one window of reading the stored body after the source recovers.
   *
   * A PERSON's failure is NOT remembered: their loader rethrows. `refreshNow` has just DROPPED the
   * cached entry, precisely because the commonest reason to click is that the last answer said the
   * source was down, so re-filling it with whatever the click found would put an `unreachable`
   * verdict in front of every dispatch for the next TTL window: a human retrying past a flaky source
   * would degrade the run path with a failure no dispatch ever observed, and each further click
   * would renew it. Leaving the entry empty is the honest state, and it costs the next dispatch one
   * probe. A SUCCESS is cached on both paths, so the dispatches after a manual refresh still inherit
   * it rather than re-asking the source.
   */
  private runLadder(
    workspaceId: string,
    source: DocumentSourceKind,
    externalId: string,
    trigger: RefreshTrigger,
    ladder: () => Promise<LinkedDocumentRefreshOutcome>,
  ): Promise<LinkedDocumentRefreshOutcome> {
    const cache = this.deps.versionCache
    if (!cache) return ladder()
    const remembering = async (): Promise<LinkedDocumentRefreshOutcome> => {
      try {
        return await ladder()
      } catch (error) {
        return this.unreachable(workspaceId, source, externalId, trigger, error)
      }
    }
    // Grouped by workspace so a workspace's connection change can drop every verdict it authorised in
    // one call, and keyed per document within it — the same shape as the fragment body cache.
    const key = probeCacheKey(source, externalId)
    return cache.get(key, workspaceId, trigger === 'dispatch' ? remembering : ladder)
  }

  /** The ONE place a failed confirmation is logged and named, however the pass reached it. */
  private unreachable(
    workspaceId: string,
    source: DocumentSourceKind,
    externalId: string,
    trigger: RefreshTrigger,
    error: unknown,
  ): LinkedDocumentRefreshOutcome {
    this.log.warn('linked document could not be confirmed against its source', {
      workspaceId,
      source,
      externalId,
      trigger,
      ...describeError(error),
    })
    return { status: 'unreachable' }
  }
}

function notApplicable(record: DocumentRecord): RefreshedDocument {
  return { record, freshness: { status: 'not-applicable' } }
}

function unconfirmed(record: DocumentRecord, reason: DocumentFreshnessGap): RefreshedDocument {
  const freshness: DocumentFreshness = { status: 'unconfirmed', reason }
  return { record, freshness }
}
