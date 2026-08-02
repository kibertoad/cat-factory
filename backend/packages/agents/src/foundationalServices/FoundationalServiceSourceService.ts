import type {
  ApiContractFormat,
  FolderScanCoverage,
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
  NotFoundError,
  ValidationError,
  assertFound,
  detectContractFormat,
  isContractCandidatePath,
  isContractModulePath,
  noopLogger,
  runBestEffort,
  summarizeContract,
} from '@cat-factory/kernel'
import pMap from 'p-map'
import {
  normalizeDirPath,
  probeRepoSourceStatus,
  syncRepoSource,
} from '../repoSourceSync/repo-source-sync.js'
import { scanContractFolder } from './folder-scan.js'
import {
  SERVICE_MANIFEST_FILE,
  commonDirectory,
  contractIdFromPath,
  contractIdFromRelativePath,
  contractTitleFromPath,
  normalizeFilePath,
  parseServiceManifest,
  parseServiceOverview,
  slugFromDirName,
} from './foundational-source.logic.js'

/**
 * What ONE sync pass dropped, accumulated across its reconcile and reported on the result.
 *
 * Created per pass rather than held on the service: two tiers can sync concurrently, and a
 * counter shared between them would attribute one link's losses to the other's result.
 */
interface ScanReport {
  /** Candidate files that did not become a contract (unreadable, unrecognised, duplicate id). */
  skipped: number
  /** How much of the folder a `folder` scan covered; null in the modes that walk nothing. */
  folderScan: FolderScanCoverage | null
}

/** How one reconcile maps a contract file path to its id within the service. */
type ContractIdForPath = (path: string) => string

/**
 * How many contract bodies one reconcile fetches at once. A `folder` source can take up to
 * {@link MAX_FOLDER_CONTRACT_FILES} documents, and paying that one round trip at a time is the
 * dominant cost of a sync that has any real work to do.
 */
const CONTRACT_READ_CONCURRENCY = 8

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
 * differentiator supplied here is what a UNIT is, and there are three of them:
 *
 * - **`directory`**: one service per immediate subdirectory, identified by its `service.md`.
 * - **`folder`**: one service, named on the LINK, whose contracts are every contract document
 *   found under `dirPath` — optionally including its subfolders.
 * - **`files`**: one service, named on the LINK, whose contracts are the linked file paths.
 *
 * Neither single-service mode has a directory convention to read identity from, which is
 * exactly why the link carries it (refused at the write boundary otherwise). What separates
 * them is WHEN the file set is decided: `files` pins the paths at link time, so a contract
 * added upstream stays invisible until somebody edits the link, while `folder` re-discovers
 * the set on every sync — which is why a spec directory that grows wants the folder shape.
 *
 * All three anchor their staleness probe on ONE directory (`dirPath`), so a `files` source with
 * a dozen linked files, and a `folder` source with a whole subtree, each still cost a single
 * commit read per freshness check.
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

  /** Link a repo folder (or file list) as a source. Does not sync (call {@link sync}). */
  async link(
    ownerKind: FoundationalServiceOwnerKind,
    ownerId: string,
    input: LinkFoundationalServiceSourceInput,
  ): Promise<FoundationalServiceSource> {
    const now = this.deps.clock.now()
    const filePaths = (input.filePaths ?? []).map(normalizeFilePath).filter(Boolean)
    // A `files` source anchors its probe on the linked files' deepest common directory, so
    // one commit read covers the whole set (see the class note). The `directory` and `folder`
    // sources anchor on the scanned subtree itself.
    const dirPath =
      input.mode === 'files' ? commonDirectory(filePaths) : normalizeDirPath(input.dirPath)
    // Both single-service modes name their service on the link; only `files` enumerates paths
    // and only `folder` walks a subtree. Storing each field solely where it is READ keeps a
    // stored row from claiming a shape its mode never uses.
    const namesService = input.mode === 'files' || input.mode === 'folder'
    const record: FoundationalServiceSourceRecord = {
      id: this.deps.idGenerator.next('fndsrc'),
      ownerKind,
      ownerId,
      repoOwner: input.repoOwner.trim(),
      repoName: input.repoName.trim(),
      gitRef: input.gitRef?.trim() || 'HEAD',
      mode: input.mode,
      dirPath,
      recursive: input.mode === 'folder' && input.recursive === true,
      filePaths: input.mode === 'files' ? filePaths : [],
      serviceId: namesService ? (input.serviceId ?? null) : null,
      serviceName: namesService ? (input.serviceName ?? null) : null,
      serviceSummary: namesService ? (input.serviceSummary ?? null) : null,
      lastSyncedCommit: null,
      lastSyncedAt: null,
      createdAt: now,
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

  private async runSync(
    source: FoundationalServiceSourceRecord,
  ): Promise<FoundationalServiceSyncResult> {
    // Invariant across the whole sync — resolved ONCE, never per file.
    const installationId = await this.requireInstallation(source)
    // Accumulated by the reconcile and lifted onto the result below. The shared engine has no
    // notion of a dropped file, and giving it one would put a foundational-services concern in
    // the module the fragment and skill libraries share.
    const report: ScanReport = { skipped: 0, folderScan: null }
    const outcome = await syncRepoSource<FoundationalServiceRecord>({
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
          // A source that has NEVER synced reaches this line only because the head probe found
          // no commit for its path AT ALL — for a repo we can read, that means the path is not
          // there. Say so: the walk short-circuits before it could observe the empty listing,
          // so without this a link with a mistyped folder syncs "successfully" forever, and the
          // author is told 0 updated / 0 removed by a source that can never produce anything.
          if (source.mode === 'folder' && source.lastSyncedCommit === null) {
            report.folderScan = 'missing'
          }
          return {
            liveIds: new Set(existing.map((s) => s.serviceId)),
            upserted: 0,
            unchanged: existing.length,
          }
        }
        const args = [source, installationId, readRef, now, existing, report] as const
        if (source.mode === 'files') return this.reconcileFiles(...args)
        if (source.mode === 'folder') return this.reconcileFolder(...args)
        return this.reconcileDirectories(...args)
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
    this.warnAboutCoverage(source, report.folderScan)
    return { ...outcome, skippedFiles: report.skipped, folderScan: report.folderScan }
  }

  /**
   * Log the two coverage outcomes an operator would want to know about, each named for the fix
   * it needs — a truncated walk asks for a narrower link, a missing folder for a corrected one.
   *
   * This is the ONLY standing signal an AUTOREFRESH pass leaves: the sweep discards the sync
   * result, so a folder that vanished upstream reaches a human through this line or not at all.
   * (A manual resync also surfaces both on the SPA's toast.)
   */
  private warnAboutCoverage(
    source: FoundationalServiceSourceRecord,
    coverage: FolderScanCoverage | null,
  ): void {
    if (coverage === null || coverage === 'complete') return
    const fields = {
      sourceId: source.id,
      ownerKind: source.ownerKind,
      ownerId: source.ownerId,
      dirPath: source.dirPath,
      recursive: source.recursive,
    }
    if (coverage === 'truncated') {
      this.log.warn('Foundational folder source truncated by a scan cap', fields)
      return
    }
    this.log.warn('Foundational folder source points at a folder that is not there', fields)
  }

  /**
   * `folder` mode: ONE service, named on the link, whose contracts are every contract document
   * under the linked folder (and its subfolders when the link says so).
   */
  private async reconcileFolder(
    source: FoundationalServiceSourceRecord,
    installationId: number,
    readRef: string,
    now: number,
    existing: FoundationalServiceRecord[],
    report: ScanReport,
  ): Promise<{ liveIds: Set<string>; upserted: number; unchanged: number; incomplete?: boolean }> {
    const { serviceId, serviceName } = this.requireNamedService(source)
    const prior = existing.find((s) => s.serviceId === serviceId)
    const scan = await scanContractFolder({
      listDir: (path) => this.listDir(source, installationId, path, readRef),
      root: source.dirPath,
      recursive: source.recursive,
    })
    report.folderScan = scan.coverage
    // Candidates the WALK declined (too large to read) join the ones that failed on their
    // bodies: both are files that looked like contracts and are not in the catalog, which is
    // the one question the count answers.
    report.skipped += scan.skippedCandidates
    const contracts = await this.readContracts({
      source,
      installationId,
      readRef,
      serviceId,
      paths: scan.paths,
      now,
      report,
      contractIdFor: (path) => contractIdFromRelativePath(path, source.dirPath),
    })
    if (contracts.length === 0) {
      // THREE different states produce zero contracts, and the disposition splits on whether we
      // have EVIDENCE about the folder — never on the empty result alone, which they share.
      //
      // STABLE — the walk saw the whole folder (`complete`), or the folder is not there at all
      // (`missing`; git cannot store an empty directory, so an empty root listing means absent),
      // and nothing under it even LOOKED like a contract. A spec folder nobody has filled in
      // yet, one holding only prose, or one emptied upstream. Pin, and let the tombstone sweep
      // retire the service, exactly as `directory` mode retires a directory that lost its
      // `service.md`. Calling this incomplete instead would hold the pin back forever: every
      // later sweep would re-walk the whole subtree to reach the same answer while the source
      // never stopped reporting changes upstream.
      if (scan.paths.length === 0 && scan.coverage !== 'truncated') {
        return { liveIds: new Set(), upserted: 0, unchanged: 0 }
      }
      // TRANSIENT — either a cap stopped the walk BEFORE it reached any candidate, or every
      // candidate it did reach read back unusable.
      //
      // The first is why the stable branch above tests coverage and not just the count: a
      // truncated walk that found nothing is a statement about the WALK, not about the folder.
      // A recursive link over a wide tree whose specs sit below the visited prefix would
      // otherwise retire a live service on the strength of directories we declined to list, and
      // pin the commit so it stayed retired. (A truncated walk that DID produce contracts is
      // stable and pins normally — it is only the absence of evidence that is not evidence.)
      //
      // The second is the same disposition `files` mode takes, for the same reason: retiring a
      // service over a momentary read failure strips a capability from every subsequent design.
      //
      // Both leave the pin behind so the next pass re-reads, and keep a prior row alive.
      if (prior) {
        return { liveIds: new Set([serviceId]), upserted: 0, unchanged: 1, incomplete: true }
      }
      return { liveIds: new Set(), upserted: 0, unchanged: 0, incomplete: true }
    }
    // An OPTIONAL `service.md` at the folder root enriches the catalog entry; it can never
    // identify the service, because the link already did that (see `parseServiceOverview`).
    const overview = await this.readFolderOverview(
      source,
      installationId,
      readRef,
      scan.manifestPath,
    )
    await this.writeService(
      source,
      {
        serviceId,
        name: serviceName,
        summary: source.serviceSummary || overview?.summary || serviceName,
        description: overview?.description ?? '',
        capabilities: overview?.capabilities ?? [],
        sourcePath: source.dirPath,
      },
      contracts,
      prior,
      readRef,
      now,
    )
    return { liveIds: new Set([serviceId]), upserted: 1, unchanged: 0 }
  }

  /** Read the folder root's optional `service.md`, or null when there is none / it is unreadable. */
  private async readFolderOverview(
    source: FoundationalServiceSourceRecord,
    installationId: number,
    readRef: string,
    manifestPath: string | null,
  ) {
    if (!manifestPath) return null
    const file = await this.readFile(source, installationId, manifestPath, readRef)
    return file ? parseServiceOverview(file.content) : null
  }

  /** `directory` mode: one service per immediate subdirectory carrying a `service.md`. */
  private async reconcileDirectories(
    source: FoundationalServiceSourceRecord,
    installationId: number,
    readRef: string,
    now: number,
    existing: FoundationalServiceRecord[],
    report: ScanReport,
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
      const contracts = await this.readContracts({
        source,
        installationId,
        readRef,
        serviceId,
        paths: entries
          .filter((e) => e.type === 'file' && e.path !== manifestEntry.path)
          .map((e) => e.path),
        now,
        report,
        contractIdFor: contractIdFromPath,
      })
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
    report: ScanReport,
  ): Promise<{ liveIds: Set<string>; upserted: number; unchanged: number; incomplete?: boolean }> {
    const { serviceId, serviceName } = this.requireNamedService(source)
    const prior = existing.find((s) => s.serviceId === serviceId)
    const contracts = await this.readContracts({
      source,
      installationId,
      readRef,
      serviceId,
      paths: source.filePaths,
      now,
      report,
      contractIdFor: contractIdFromPath,
      // The link is an explicit list a human wrote, so a named module the set's contract
      // imports rides with it rather than being dropped as unrecognised.
      admitSupportingModules: true,
    })
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
        name: serviceName,
        summary: source.serviceSummary ?? serviceName,
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
   * The identity a single-service source names, or a refusal.
   *
   * Guaranteed by the link-time `v.check`, but a stored row outlives the schema that wrote it —
   * so this is a real guard, not a type-narrowing convenience. It returns BOTH proven fields
   * rather than just the id, so a caller narrows by using the result instead of re-asserting
   * `serviceName as string` at each use — a cast that would survive the guard being weakened.
   */
  private requireNamedService(source: FoundationalServiceSourceRecord): {
    serviceId: string
    serviceName: string
  } {
    if (!source.serviceId || !source.serviceName) {
      throw new ValidationError('This source does not name the service its contracts describe', {
        reason: 'foundational_source_unnamed_service',
        sourceId: source.id,
      })
    }
    return { serviceId: source.serviceId, serviceName: source.serviceName }
  }

  /**
   * Read the given repo paths and keep the ones that ARE contract documents. A file whose
   * format is unrecognised is skipped rather than stored as an opaque blob: the format is what
   * tells a downstream agent how to read it, and a "contract" nobody can interpret is worse in
   * an agent's context than an absent one.
   *
   * A path that could never yield a format is dropped without a read and without a count — it
   * is a README or a `package.json` beside the specs, not a contract that failed. Everything
   * else that fails is COUNTED on the report and NAMED in the log (see {@link skip}), because a
   * link that produced fewer contracts than its author expected has no other explanation
   * available to them.
   *
   * `admitSupportingModules` relaxes exactly one of those rules, for `files` mode only: a
   * TypeScript module that references no contract library rides along under the format the rest
   * of the set resolved to. A contract module is a module GRAPH — the `defineApiContract` module
   * plus the schema modules it imports — and only the entry point names the library, so without
   * this the linked halves of ONE contract are dropped and a coder is handed imports that point
   * at nothing. It is safe HERE and nowhere else because a `files` link is an explicit list a
   * human wrote: the link plays the same role the `format` field plays on an upload. A `folder`
   * or `directory` scan walks paths nobody named, so it keeps the content-led rule, or one link
   * would sweep a repo's TypeScript into an agent's context as "contracts".
   */
  private async readContracts(params: {
    source: FoundationalServiceSourceRecord
    installationId: number
    readRef: string
    serviceId: string
    paths: string[]
    now: number
    report: ScanReport
    contractIdFor: ContractIdForPath
    admitSupportingModules?: boolean
  }): Promise<ApiContractRecord[]> {
    const { source, installationId, readRef, serviceId, paths, now, report, contractIdFor } = params
    const out: ApiContractRecord[] = []
    const seen = new Set<string>()
    // Read the bodies concurrently, then DECIDE over them in path order. The split matters: the
    // reads are independent, but the id dedupe keeps the FIRST claimant of a colliding id, so
    // the decision pass has to run in a deterministic order or which contract survives would
    // depend on which response arrived first. `pMap` resolves in input order, so it does.
    const fetched = await pMap(
      paths.filter(isContractCandidatePath),
      async (path) => ({ path, file: await this.readFile(source, installationId, path, readRef) }),
      { concurrency: CONTRACT_READ_CONCURRENCY },
    )
    // Detect each readable file's format ONCE. The set-wide decision below and the per-file one
    // in the loop are the same question asked twice, and content detection scans a document that
    // can run to `MAX_CONTRACT_BODY_CHARS`.
    const detected = fetched.map(({ path, file }) => ({
      path,
      file,
      format: file ? detectContractFormat(path, file.content) : null,
    }))
    // The format the SET resolved to, decided over every readable file before any is stored: a
    // supporting module can be linked before the contract that names the library, so a
    // left-to-right pass would drop it on the strength of files it had not read yet.
    const setModuleFormat = params.admitSupportingModules
      ? moduleFormatOfSet(detected.map((entry) => entry.format))
      : null
    for (const { path, file, format: detectedFormat } of detected) {
      if (!file) {
        this.skip(report, source, path, 'unreadable')
        continue
      }
      const format = detectedFormat ?? supportingModuleFormat(path, setModuleFormat)
      if (!format) {
        this.skip(report, source, path, 'unrecognised')
        continue
      }
      const contractId = contractIdFor(path)
      if (seen.has(contractId)) {
        this.skip(report, source, path, 'duplicate-contract-id', { contractId })
        continue
      }
      seen.add(contractId)
      const summary = summarizeContract({
        contractId,
        format,
        title: contractTitleFromPath(path),
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

  /**
   * Count one dropped candidate and name it in the log.
   *
   * The count alone answers "did I lose anything?" but never "which file, and why?" — and one
   * reason is undiagnosable without the log line: a DUPLICATE contract id silently keeps the
   * first claimant, so the losing document is absent from the catalog under a name that is
   * present. `debug` rather than `warn` because a thin catalog entry is usually intended (prose
   * and drafts sit beside specs); the count on the sync result is what asks for attention.
   */
  private skip(
    report: ScanReport,
    source: FoundationalServiceSourceRecord,
    path: string,
    reason: 'unreadable' | 'unrecognised' | 'duplicate-contract-id',
    fields?: Record<string, unknown>,
  ): void {
    report.skipped++
    this.log.debug('Skipped a foundational contract candidate', {
      sourceId: source.id,
      ownerKind: source.ownerKind,
      ownerId: source.ownerId,
      path,
      reason,
      ...fields,
    })
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

/**
 * The single TypeScript contract format a linked SET resolved to, or null when it resolved to
 * none or to more than one.
 *
 * More than one is deliberately null rather than a pick: with a `@toad-contracts/core` module
 * and a `@lokalise/api-contract` module in one linked set there is no telling which library an
 * unrecognised module supports, and attaching it to the wrong one would present a coder with a
 * module the contract beside it does not import.
 */
function moduleFormatOfSet(detected: (ApiContractFormat | null)[]): ApiContractFormat | null {
  const formats = new Set(
    detected.filter(
      (format): format is ApiContractFormat => format !== null && format !== 'openapi',
    ),
  )
  return formats.size === 1 ? [...formats][0]! : null
}

/**
 * A linked module the set's format vouches for; null for anything that is not a module.
 *
 * "Is this a module?" is kernel's `isContractModulePath`, not a local extension list, so this
 * admits exactly what `detectContractFormat` would have looked at — a second list here would
 * silently drop a linked `.mts` schema module the detector beside it recognises.
 */
function supportingModuleFormat(
  path: string,
  setFormat: ApiContractFormat | null,
): ApiContractFormat | null {
  if (!setFormat) return null
  return isContractModulePath(path) ? setFormat : null
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
    recursive: record.recursive,
    filePaths: record.filePaths,
    serviceId: record.serviceId,
    serviceName: record.serviceName,
    serviceSummary: record.serviceSummary,
    lastSyncedCommit: record.lastSyncedCommit,
    lastSyncedAt: record.lastSyncedAt,
    createdAt: record.createdAt,
  }
}
