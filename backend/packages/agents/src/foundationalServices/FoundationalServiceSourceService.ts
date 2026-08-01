import type {
  FoundationalServiceOwnerKind,
  FoundationalServiceSource,
  FoundationalServiceSourceStatus,
  FoundationalServiceSyncResult,
  LinkFoundationalServiceSourceInput,
} from '@cat-factory/contracts'
import type {
  ApiContractRecord,
  ApiContractRepository,
  Clock,
  FoundationalServiceRecord,
  FoundationalServiceRepository,
  FoundationalServiceSourceRecord,
  FoundationalServiceSourceRepository,
  GitHubClient,
  IdGenerator,
  Logger,
  RepoContentEntry,
} from '@cat-factory/kernel'
import {
  ConflictError,
  NotFoundError,
  ValidationError,
  assertFound,
  describeError,
  detectContractFormat,
  noopLogger,
  openApiTitle,
  runBestEffort,
  summarizeContract,
} from '@cat-factory/kernel'
import {
  normalizeDirPath,
  probeRepoSourceStatus,
  syncRepoSource,
} from '../repoSourceSync/repo-source-sync.js'
import {
  SERVICE_MANIFEST_FILE,
  commonDirectory,
  contractIdFromPath,
  contractTitleFromPath,
  normalizeFilePath,
  parseServiceManifest,
  slugFromDirName,
} from './foundational-source.logic.js'

/**
 * Resolve the GitHub App installation id that can read a tier's repos — a workspace source
 * reads through the workspace's installation, an account source through the account's.
 * Returns null when none is available, so a sync fails with a clear error rather than a
 * silent empty pull.
 */
export type ResolveFoundationalInstallationId = (
  ownerKind: FoundationalServiceOwnerKind,
  ownerId: string,
) => Promise<number | null>

export interface FoundationalServiceSourceServiceDependencies {
  foundationalServiceSourceRepository: FoundationalServiceSourceRepository
  foundationalServiceRepository: FoundationalServiceRepository
  apiContractRepository: ApiContractRepository
  githubClient: GitHubClient
  resolveInstallationId: ResolveFoundationalInstallationId
  idGenerator: IdGenerator
  clock: Clock
  logger?: Logger
  /** Drops the cached merged catalog for a tier after a sync/unlink changed a row. */
  invalidateCatalog?: (ownerKind: FoundationalServiceOwnerKind, ownerId: string) => Promise<void>
}

/**
 * Repo-sourced foundational services: link a repo FOLDER of service definitions (or an
 * explicit FILE list for one service), resync it, and answer the cheap "check for changes"
 * without writing. Reads go through the tier's existing GitHub installation — no new
 * credential store.
 *
 * The shared repo-source engine (`repoSourceSync`) owns the mechanics that every repo-sourced
 * library gets identically — pin the head commit BEFORE reading, run the reconcile, sweep
 * tombstones by produced id, stamp the sync state, invalidate only on a real change. The
 * differentiator supplied here is what a UNIT is, and there are two of them:
 *
 * - **`directory`**: one service per immediate subdirectory, identified by its `service.md`.
 * - **`files`**: one service, named on the LINK, whose contracts are the linked file paths.
 *   There is no directory convention to read identity from, which is exactly why the link
 *   carries it (refused at the write boundary otherwise).
 *
 * Both modes anchor their staleness probe on ONE directory (`dirPath`), so a `files` source
 * with a dozen linked files still costs a single commit read per freshness check.
 */
export class FoundationalServiceSourceService {
  private readonly log: Logger

  constructor(private readonly deps: FoundationalServiceSourceServiceDependencies) {
    this.log = deps.logger ?? noopLogger
  }

  /** Linked sources for a tier + their last-synced state. */
  async list(
    ownerKind: FoundationalServiceOwnerKind,
    ownerId: string,
  ): Promise<FoundationalServiceSource[]> {
    const rows = await this.deps.foundationalServiceSourceRepository.listByOwner(ownerKind, ownerId)
    return rows.map(toWire)
  }

  /**
   * Link a repo folder (or file list) as a source. Does not sync (call {@link sync}).
   *
   * A location is UNIQUE per tier (`owner × repo × ref × dirPath`), and an unlink only
   * tombstones, so re-linking somewhere previously unlinked REVIVES that row rather than
   * inserting a second one — inserting would hit the unique index and surface as a 500 on a
   * perfectly ordinary unlink/relink. A location that is still LIVE is a 409, not a silent
   * re-configure of the source someone else is relying on.
   */
  async link(
    ownerKind: FoundationalServiceOwnerKind,
    ownerId: string,
    input: LinkFoundationalServiceSourceInput,
  ): Promise<FoundationalServiceSource> {
    const now = this.deps.clock.now()
    const filePaths = (input.filePaths ?? []).map(normalizeFilePath).filter(Boolean)
    // A `files` source anchors its probe on the linked files' deepest common directory, so
    // one commit read covers the whole set (see the class note). A `directory` source anchors
    // on the scanned subtree itself.
    const dirPath =
      input.mode === 'files' ? commonDirectory(filePaths) : normalizeDirPath(input.dirPath)
    const location = {
      repoOwner: input.repoOwner.trim(),
      repoName: input.repoName.trim(),
      gitRef: input.gitRef?.trim() || 'HEAD',
      dirPath,
    }
    const existing = await this.deps.foundationalServiceSourceRepository.getByLocation(
      ownerKind,
      ownerId,
      location,
    )
    if (existing && existing.deletedAt === null) {
      throw new ConflictError(
        'This repository location is already linked as a foundational-service source',
        'foundational_source_exists',
        { sourceId: existing.id },
      )
    }
    const record: FoundationalServiceSourceRecord = {
      id: existing?.id ?? this.deps.idGenerator.next('fndsrc'),
      ownerKind,
      ownerId,
      ...location,
      mode: input.mode,
      filePaths,
      serviceId: input.mode === 'files' ? (input.serviceId ?? null) : null,
      serviceName: input.mode === 'files' ? (input.serviceName ?? null) : null,
      serviceSummary: input.mode === 'files' ? (input.serviceSummary ?? null) : null,
      // A revived link starts from ZERO sync state, never the pin it carried when it was
      // unlinked. `unlink` tombstoned every service the source had produced, so a retained pin
      // would make the next pass short-circuit on `!commitMoved` — an unchanged repo — and
      // re-create none of them, leaving a source that reports itself synced and produces nothing.
      lastSyncedCommit: null,
      lastSyncedAt: null,
      lastAttemptedAt: null,
      lastError: null,
      createdAt: existing?.createdAt ?? now,
      deletedAt: null,
    }
    await this.deps.foundationalServiceSourceRepository.upsert(record)
    return toWire(record)
  }

  /** Unlink a source and tombstone every service it produced. */
  async unlink(
    ownerKind: FoundationalServiceOwnerKind,
    ownerId: string,
    sourceId: string,
  ): Promise<void> {
    const source = await this.require(ownerKind, ownerId, sourceId)
    const now = this.deps.clock.now()
    const services = await this.deps.foundationalServiceRepository.listBySource(sourceId)
    if (services.length > 0) {
      await this.deps.foundationalServiceRepository.softDeleteBySource(sourceId, now)
      for (const service of services) {
        await this.deps.apiContractRepository.deleteForService(
          service.ownerKind,
          service.ownerId,
          service.serviceId,
        )
      }
    }
    await this.deps.foundationalServiceSourceRepository.softDelete(source.id, now)
    if (services.length > 0) await this.deps.invalidateCatalog?.(ownerKind, ownerId)
  }

  /** The cheap "check for changes": one head-commit read compared to the pinned commit. */
  async status(
    ownerKind: FoundationalServiceOwnerKind,
    ownerId: string,
    sourceId: string,
  ): Promise<FoundationalServiceSourceStatus> {
    const source = await this.require(ownerKind, ownerId, sourceId)
    const installationId = await this.requireInstallation(source)
    return probeRepoSourceStatus({ source, installationId, githubClient: this.deps.githubClient })
  }

  /** Resync a source by id, resolving its owner from the stored row (the sweeper's entry point). */
  async syncById(sourceId: string): Promise<FoundationalServiceSyncResult> {
    const source = assertFound(
      await this.deps.foundationalServiceSourceRepository.get(sourceId),
      'FoundationalServiceSource',
      sourceId,
    )
    if (source.deletedAt !== null) throw new NotFoundError('FoundationalServiceSource', sourceId)
    return this.runSync(source)
  }

  /** Resync a source: read the tree, upsert changed services, tombstone removed ones. */
  async sync(
    ownerKind: FoundationalServiceOwnerKind,
    ownerId: string,
    sourceId: string,
  ): Promise<FoundationalServiceSyncResult> {
    return this.runSync(await this.require(ownerKind, ownerId, sourceId))
  }

  /**
   * AUTOREFRESH: resync every source whose last sync is older than `staleAfterMs`, bounded to
   * `limit` per pass. Driven by the periodic sweep on both facades (a Cloudflare cron tick, a
   * Node interval), so a linked repo stays fresh whether or not anyone opens the management
   * surface or starts a run.
   *
   * Best-effort PER SOURCE: one repo whose installation was revoked must not stop the pass from
   * refreshing the rest, so each failure is logged with its cause and the sweep continues. The
   * count returned is sources SYNCED, not sources attempted.
   */
  async refreshStale(staleAfterMs: number, limit: number): Promise<number> {
    const now = this.deps.clock.now()
    const stale = await this.deps.foundationalServiceSourceRepository.listStale(
      now - staleAfterMs,
      limit,
    )
    let synced = 0
    for (const source of stale) {
      const result = await runBestEffort(
        this.log,
        'foundationalServices.refreshSource',
        () => this.runSync(source),
        { sourceId: source.id, ownerKind: source.ownerKind, ownerId: source.ownerId },
      )
      if (result) synced++
    }
    return synced
  }

  // --- internals ----------------------------------------------------------

  /**
   * Run a sync, recording the ATTEMPT either way.
   *
   * The failure branch is what keeps the autorefresh sweep fair. `syncRepoSource` stamps the
   * sync state only once it completes, so a source that THROWS — a revoked installation, a
   * deleted repo, a rate limit — would otherwise keep its old timestamp, stay permanently the
   * least-recently-attempted row, and re-occupy the head of every bounded batch. Twenty such
   * sources and no healthy source in the deployment ever refreshes again, with nothing to show
   * for it but a warn line per tick.
   *
   * The cause is PERSISTED rather than only logged, so a source broken for a week is visible as
   * broken on the management surface instead of merely looking old. It is scrubbed through
   * `describeError`, because a GitHub client error routinely echoes the request URL.
   *
   * The error still propagates: an operator who pressed "sync" gets the failure, and the
   * sweep's own `runBestEffort` is what turns it into a logged-and-continue there. Recording is
   * itself best-effort, because the ONE cause worth surfacing is the sync's — a store that is
   * also down must not replace "your installation was revoked" with its own write error.
   */
  private async runSync(
    source: FoundationalServiceSourceRecord,
  ): Promise<FoundationalServiceSyncResult> {
    try {
      return await this.attemptSync(source)
    } catch (error) {
      await runBestEffort(
        this.log,
        'foundationalServices.recordSyncFailure',
        () =>
          this.deps.foundationalServiceSourceRepository.recordSyncFailure(
            source.id,
            this.deps.clock.now(),
            syncFailureCause(error),
          ),
        { sourceId: source.id },
      )
      throw error
    }
  }

  private async attemptSync(
    source: FoundationalServiceSourceRecord,
  ): Promise<FoundationalServiceSyncResult> {
    // Invariant across the whole sync — resolved ONCE, never per file.
    const installationId = await this.requireInstallation(source)
    return syncRepoSource<FoundationalServiceRecord>({
      source,
      installationId,
      githubClient: this.deps.githubClient,
      now: this.deps.clock.now(),
      listExisting: () => this.deps.foundationalServiceRepository.listBySource(source.id),
      existingId: (s) => s.serviceId,
      reconcile: async ({ readRef, commitMoved, now }, existing) => {
        // The source dir's head commit is the exact staleness signal: unchanged ⇒ nothing under
        // it moved (manifest OR contract document), so every service is unchanged and not a
        // single per-directory read is paid for.
        if (!commitMoved) {
          return {
            liveIds: new Set(existing.map((s) => s.serviceId)),
            upserted: 0,
            unchanged: existing.length,
          }
        }
        return source.mode === 'files'
          ? this.reconcileFiles(source, installationId, readRef, now, existing)
          : this.reconcileDirectories(source, installationId, readRef, now, existing)
      },
      tombstone: async (service, now) => {
        await this.deps.foundationalServiceRepository.softDelete(
          service.ownerKind,
          service.ownerId,
          service.serviceId,
          now,
        )
        await this.deps.apiContractRepository.deleteForService(
          service.ownerKind,
          service.ownerId,
          service.serviceId,
        )
      },
      updateSyncState: (commit, now) =>
        this.deps.foundationalServiceSourceRepository.updateSyncState(source.id, commit, now),
      invalidate: () =>
        this.deps.invalidateCatalog?.(source.ownerKind, source.ownerId) ?? Promise.resolve(),
    })
  }

  /** `directory` mode: one service per immediate subdirectory carrying a `service.md`. */
  private async reconcileDirectories(
    source: FoundationalServiceSourceRecord,
    installationId: number,
    readRef: string,
    now: number,
    existing: FoundationalServiceRecord[],
  ): Promise<{ liveIds: Set<string>; upserted: number; unchanged: number; incomplete?: boolean }> {
    const existingById = new Map(existing.map((s) => [s.serviceId, s]))
    // Sorted by name (code-unit order, locale-independent) so slug-collision resolution is
    // deterministic — first wins — regardless of ICU collation.
    const dirs = (await this.listDir(source, installationId, source.dirPath, readRef))
      .filter((e) => e.type === 'dir')
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    const liveIds = new Set<string>()
    const seenSlugs = new Set<string>()
    let upserted = 0
    let incomplete = false
    for (const dir of dirs) {
      const serviceId = slugFromDirName(dir.name)
      // Two sibling dirs can slug to the same id (`file_storage` + `file-storage`). Keep the
      // first deterministically rather than silently overwriting one service's row with
      // another's.
      if (seenSlugs.has(serviceId)) continue
      seenSlugs.add(serviceId)
      const entries = await this.listDir(source, installationId, dir.path, readRef)
      const manifestEntry = entries.find(
        (e) => e.type === 'file' && e.name.toLowerCase() === SERVICE_MANIFEST_FILE,
      )
      // A directory with no manifest is not a service — skip it entirely rather than
      // registering an unnamed one. It never enters `liveIds`, so a directory that LOSES its
      // manifest retires the service it used to describe.
      if (!manifestEntry) continue
      const manifestFile = await this.readFile(source, installationId, manifestEntry.path, readRef)
      const parsed = manifestFile ? parseServiceManifest(manifestFile.content) : null
      if (!parsed) {
        // Unreadable/unparseable THIS round: keep any prior row alive rather than retiring a
        // service over a transient read or an in-progress edit, and leave the pinned commit
        // behind so the next sync re-reads it.
        const prior = existingById.get(serviceId)
        if (prior) {
          liveIds.add(serviceId)
          incomplete = true
        }
        continue
      }
      const contracts = await this.readContracts(
        source,
        installationId,
        readRef,
        serviceId,
        entries
          .filter((e) => e.type === 'file' && e.path !== manifestEntry.path)
          .map((e) => e.path),
        now,
      )
      await this.writeService(
        source,
        {
          serviceId,
          name: parsed.name,
          summary: parsed.summary,
          description: parsed.description,
          capabilities: parsed.capabilities,
          sourcePath: dir.path,
        },
        contracts,
        existingById.get(serviceId),
        readRef,
        now,
      )
      liveIds.add(serviceId)
      upserted++
    }
    // Every live service is rewritten on a moved commit, so nothing is reported unchanged —
    // the cheap path is the `!commitMoved` short-circuit above, which is where an untouched
    // source actually saves its reads.
    return { liveIds, upserted, unchanged: 0, ...(incomplete ? { incomplete: true } : {}) }
  }

  /** `files` mode: ONE service, named on the link, whose contracts are the linked paths. */
  private async reconcileFiles(
    source: FoundationalServiceSourceRecord,
    installationId: number,
    readRef: string,
    now: number,
    existing: FoundationalServiceRecord[],
  ): Promise<{ liveIds: Set<string>; upserted: number; unchanged: number; incomplete?: boolean }> {
    const serviceId = source.serviceId
    // Guaranteed by the link-time `v.check`, but a stored row outlives the schema that wrote
    // it — so this is a real guard, not a type narrowing convenience.
    if (!serviceId || !source.serviceName) {
      throw new ValidationError('This source does not name the service its files describe', {
        reason: 'foundational_source_unnamed_service',
        sourceId: source.id,
      })
    }
    const prior = existing.find((s) => s.serviceId === serviceId)
    const contracts = await this.readContracts(
      source,
      installationId,
      readRef,
      serviceId,
      source.filePaths,
      now,
    )
    if (contracts.length === 0) {
      // Every linked file read back unusable. Keep a prior row alive and leave the pin behind
      // so the next pass re-reads — the alternative is retiring a service that a momentary
      // read failure made look deleted.
      if (prior)
        return { liveIds: new Set([serviceId]), upserted: 0, unchanged: 1, incomplete: true }
      return { liveIds: new Set(), upserted: 0, unchanged: 0, incomplete: true }
    }
    await this.writeService(
      source,
      {
        serviceId,
        name: source.serviceName,
        summary: source.serviceSummary ?? source.serviceName,
        description: '',
        capabilities: [],
        sourcePath: source.dirPath,
      },
      contracts,
      prior,
      readRef,
      now,
    )
    return { liveIds: new Set([serviceId]), upserted: 1, unchanged: 0 }
  }

  /**
   * Read the given repo paths and keep the ones that ARE contract documents. A file whose
   * format is unrecognised is skipped rather than stored as an opaque blob: the format is what
   * tells a downstream agent how to read it, and a "contract" nobody can interpret is worse in
   * an agent's context than an absent one.
   */
  private async readContracts(
    source: FoundationalServiceSourceRecord,
    installationId: number,
    readRef: string,
    serviceId: string,
    paths: string[],
    now: number,
  ): Promise<ApiContractRecord[]> {
    const out: ApiContractRecord[] = []
    const seen = new Set<string>()
    for (const path of paths) {
      const file = await this.readFile(source, installationId, path, readRef)
      if (!file) continue
      const format = detectContractFormat(path, file.content)
      if (!format) continue
      const contractId = contractIdFromPath(path)
      if (seen.has(contractId)) continue
      seen.add(contractId)
      const summary = summarizeContract({
        contractId,
        format,
        // The document's own `info.title` when it has one — every service's OpenAPI file is
        // called `openapi.yaml`, so the filename identifies nothing in a catalog of them.
        title: openApiTitle(file.content) ?? contractTitleFromPath(path),
        path,
        body: file.content,
      })
      out.push({
        ownerKind: source.ownerKind,
        ownerId: source.ownerId,
        serviceId,
        contractId,
        format,
        title: summary.title,
        body: file.content,
        operations: summary.operations,
        omittedOperations: summary.omittedOperations,
        sourcePath: path,
        sourceSha: file.sha,
        createdAt: now,
        updatedAt: now,
      })
    }
    return out
  }

  private async writeService(
    source: FoundationalServiceSourceRecord,
    identity: {
      serviceId: string
      name: string
      summary: string
      description: string
      capabilities: string[]
      sourcePath: string
    },
    contracts: ApiContractRecord[],
    prior: FoundationalServiceRecord | undefined,
    readRef: string,
    now: number,
  ): Promise<void> {
    await this.deps.foundationalServiceRepository.upsert({
      serviceId: identity.serviceId,
      ownerKind: source.ownerKind,
      ownerId: source.ownerId,
      name: identity.name,
      summary: identity.summary,
      description: identity.description,
      capabilities: identity.capabilities,
      sourceId: source.id,
      sourcePath: identity.sourcePath,
      pinnedCommit: readRef,
      createdAt: prior?.createdAt ?? now,
      updatedAt: now,
      deletedAt: null,
    })
    await this.deps.apiContractRepository.replaceForService(
      source.ownerKind,
      source.ownerId,
      identity.serviceId,
      contracts,
    )
  }

  private listDir(
    source: FoundationalServiceSourceRecord,
    installationId: number,
    path: string,
    readRef: string,
  ): Promise<RepoContentEntry[]> {
    return this.deps.githubClient.listDirectory(
      installationId,
      { owner: source.repoOwner, repo: source.repoName },
      path,
      readRef,
    )
  }

  private readFile(
    source: FoundationalServiceSourceRecord,
    installationId: number,
    path: string,
    readRef: string,
  ) {
    return this.deps.githubClient.getFileContent(
      installationId,
      { owner: source.repoOwner, repo: source.repoName },
      path,
      readRef,
    )
  }

  private async require(
    ownerKind: FoundationalServiceOwnerKind,
    ownerId: string,
    sourceId: string,
  ): Promise<FoundationalServiceSourceRecord> {
    const source = assertFound(
      await this.deps.foundationalServiceSourceRepository.get(sourceId),
      'FoundationalServiceSource',
      sourceId,
    )
    // The route gates only authorize the addressed owner prefix, so the record must belong to
    // that owner; a 404 hides other tenants' sources entirely.
    if (source.ownerKind !== ownerKind || source.ownerId !== ownerId || source.deletedAt !== null) {
      throw new NotFoundError('FoundationalServiceSource', sourceId)
    }
    return source
  }

  private async requireInstallation(source: FoundationalServiceSourceRecord): Promise<number> {
    const installationId = await this.deps.resolveInstallationId(source.ownerKind, source.ownerId)
    if (installationId === null) {
      throw new ValidationError(
        'No GitHub installation is available for this scope; connect GitHub before syncing a source',
        { reason: 'foundational_source_no_installation', sourceId: source.id },
      )
    }
    return installationId
  }
}

/** How much of a failure cause is retained on the row. Enough to diagnose, bounded for a column. */
const MAX_SYNC_ERROR_CHARS = 500

/**
 * The stored cause of a failed sync: scrubbed (a GitHub client error routinely echoes the request
 * URL, and `describeError` runs it through `redactSecrets`) and bounded, since the message is
 * model- and vendor-authored text landing in a column every source listing reads.
 */
function syncFailureCause(error: unknown): string {
  const cause = String(describeError(error).err ?? '')
  return cause.length > MAX_SYNC_ERROR_CHARS ? `${cause.slice(0, MAX_SYNC_ERROR_CHARS)}…` : cause
}

function toWire(record: FoundationalServiceSourceRecord): FoundationalServiceSource {
  return {
    id: record.id,
    ownerKind: record.ownerKind,
    ownerId: record.ownerId,
    repoOwner: record.repoOwner,
    repoName: record.repoName,
    gitRef: record.gitRef,
    mode: record.mode,
    dirPath: record.dirPath,
    filePaths: record.filePaths,
    serviceId: record.serviceId,
    serviceName: record.serviceName,
    serviceSummary: record.serviceSummary,
    lastSyncedCommit: record.lastSyncedCommit,
    lastSyncedAt: record.lastSyncedAt,
    // Surfaced so a source that has been failing for a week reads as BROKEN rather than merely
    // old: `lastSyncedAt` alone cannot tell "nothing upstream changed" from "every attempt since
    // Tuesday threw", and those need very different reactions from an operator.
    lastAttemptedAt: record.lastAttemptedAt,
    lastError: record.lastError,
    createdAt: record.createdAt,
  }
}
