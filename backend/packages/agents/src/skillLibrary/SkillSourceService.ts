import type {
  AccountSkillRecord,
  AccountSkillRepository,
  Clock,
  GitHubClient,
  IdGenerator,
  SkillResource,
  SkillSourceRecord,
  SkillSourceRepository,
} from '@cat-factory/kernel'
import { NotFoundError, ValidationError, assertFound } from '@cat-factory/kernel'
import type {
  LinkSkillSourceInput,
  SkillSource,
  SkillSourceStatus,
  SkillSyncResult,
} from '@cat-factory/contracts'
import {
  normalizeDirPath,
  probeRepoSourceStatus,
  syncRepoSource,
} from '../repoSourceSync/repo-source-sync.js'
import { isSkillManifest, parseSkillManifest, slugFromDirName } from './skill-source.logic.js'

/**
 * Resolve the GitHub App installation id that can read an account's repos. Returns
 * null when no installation is available, so a sync fails with a clear error rather
 * than a silent empty pull.
 */
export type ResolveSkillInstallationId = (accountId: string) => Promise<number | null>

export interface SkillSourceServiceDependencies {
  skillSourceRepository: SkillSourceRepository
  accountSkillRepository: AccountSkillRepository
  githubClient: GitHubClient
  resolveInstallationId: ResolveSkillInstallationId
  idGenerator: IdGenerator
  clock: Clock
  /**
   * Drops the cached skill catalog for an account after this service mutates its
   * skills (sync/unlink) — wired to {@link SkillCatalogService.invalidate} by the
   * composition root. Absent (tests) ⇒ no cache to keep coherent.
   */
  invalidateCatalog?: (accountId: string) => Promise<void>
}

/**
 * Repo-sourced Claude skills (docs/initiatives/repo-skills.md): link a repo
 * directory of skill folders to an account, resync it (read each `<skill>/SKILL.md`
 * directory, upsert changed skills, tombstone removed ones), and answer the cheap
 * "check for changes" without writing. Reads go through the account's existing
 * GitHub installation — no new credential store. The shared repo-source engine
 * (repoSourceSync) owns the sync mechanics; this service supplies the skill
 * differentiator: the sync unit is a DIRECTORY (`<skill>/SKILL.md` + its sibling
 * resources), and a resource-only edit (which advances the dir head commit without
 * touching `SKILL.md`'s blob sha) is caught by re-reading whenever the pinned commit
 * moved.
 */
export class SkillSourceService {
  constructor(private readonly deps: SkillSourceServiceDependencies) {}

  /** Linked sources for an account + their last-synced state. */
  async list(accountId: string): Promise<SkillSource[]> {
    const rows = await this.deps.skillSourceRepository.listByAccount(accountId)
    return rows.map(toWire)
  }

  /** Link a repo directory as a skill source. Does not sync (call {@link sync}). */
  async link(accountId: string, input: LinkSkillSourceInput): Promise<SkillSource> {
    const now = this.deps.clock.now()
    const record: SkillSourceRecord = {
      id: this.deps.idGenerator.next('sklsrc'),
      accountId,
      repoOwner: input.repoOwner.trim(),
      repoName: input.repoName.trim(),
      gitRef: input.gitRef?.trim() || 'HEAD',
      dirPath: normalizeDirPath(input.dirPath),
      lastSyncedCommit: null,
      lastSyncedAt: null,
      createdAt: now,
      deletedAt: null,
    }
    await this.deps.skillSourceRepository.upsert(record)
    return toWire(record)
  }

  /** Unlink a source and tombstone every skill it produced. */
  async unlink(accountId: string, sourceId: string): Promise<void> {
    const source = await this.require(accountId, sourceId)
    const now = this.deps.clock.now()
    const skills = await this.deps.accountSkillRepository.listBySource(sourceId)
    if (skills.length > 0) {
      await this.deps.accountSkillRepository.softDeleteBySource(sourceId, now)
    }
    await this.deps.skillSourceRepository.softDelete(source.id, now)
    if (skills.length > 0) await this.deps.invalidateCatalog?.(accountId)
  }

  /**
   * Resync a source: read each `<skill>/SKILL.md` directory, upsert every skill whose
   * manifest or resource manifest changed, tombstone skills no longer produced, and
   * stamp the source dir's head commit. Idempotent — re-running with no upstream change
   * touches nothing.
   */
  async sync(accountId: string, sourceId: string): Promise<SkillSyncResult> {
    const source = await this.require(accountId, sourceId)
    const installationId = await this.requireInstallation(source)
    return syncRepoSource<AccountSkillRecord>({
      source,
      installationId,
      githubClient: this.deps.githubClient,
      now: this.deps.clock.now(),
      listExisting: () => this.deps.accountSkillRepository.listBySource(sourceId),
      existingId: (s) => s.skillId,
      reconcile: async ({ readRef, commitMoved, now }, existing) => {
        const existingById = new Map(existing.map((s) => [s.skillId, s]))
        // The head commit for the whole source dir is the exact staleness signal: if it
        // has not advanced since the last sync, NOTHING under it changed (manifest OR
        // resource), so every skill is unchanged and we skip all per-directory reads.
        if (!commitMoved) {
          return {
            liveIds: new Set(existing.map((s) => s.skillId)),
            upserted: 0,
            unchanged: existing.length,
          }
        }
        // Sort dirs by name (code-unit order, locale-independent) so slug-collision
        // resolution is deterministic — first wins — regardless of ICU collation.
        const dirs = (await this.listDir(source, installationId, source.dirPath, readRef))
          .filter((e) => e.type === 'dir')
          .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
        const liveIds = new Set<string>()
        const seenSlugs = new Set<string>()
        let upserted = 0
        let unchanged = 0
        let incomplete = false
        for (const dir of dirs) {
          const slug = slugFromDirName(dir.name)
          // Two sibling dirs can slug to the same id (e.g. `release_notes` + `release-notes`,
          // both → `release-notes`). Keep the first (sorted order) deterministically and skip
          // the rest rather than silently overwriting one skill's row with another's.
          if (seenSlugs.has(slug)) continue
          seenSlugs.add(slug)
          const skillId = `src:${source.id}:${slug}`
          const synced = await this.syncSkillDir(
            source,
            dir.name,
            dir.path,
            skillId,
            existingById.get(skillId),
            installationId,
            readRef,
            now,
          )
          if (synced === 'skip') continue
          // 'kept'/'stale' (both keep a prior row) and 'upserted' all survive the tombstone
          // sweep — a transient failure must never retire an existing skill.
          liveIds.add(skillId)
          if (synced === 'upserted') upserted++
          else unchanged++
          // A detected-but-unapplied change leaves us not caught up to the head commit.
          if (synced === 'stale') incomplete = true
        }
        return { liveIds, upserted, unchanged, incomplete }
      },
      tombstone: (s, now) =>
        this.deps.accountSkillRepository.softDelete(s.accountId, s.skillId, now),
      updateSyncState: (commit, now) =>
        this.deps.skillSourceRepository.updateSyncState(source.id, commit, now),
      invalidate: () => this.deps.invalidateCatalog?.(accountId) ?? Promise.resolve(),
    })
  }

  /** Lightweight "check for changes": one head-commit read compared to the last sync. */
  async status(accountId: string, sourceId: string): Promise<SkillSourceStatus> {
    const source = await this.require(accountId, sourceId)
    const installationId = await this.requireInstallation(source)
    return probeRepoSourceStatus({ source, installationId, githubClient: this.deps.githubClient })
  }

  // --- internals ----------------------------------------------------------

  private async require(accountId: string, sourceId: string): Promise<SkillSourceRecord> {
    const source = assertFound(
      await this.deps.skillSourceRepository.get(sourceId),
      'SkillSource',
      sourceId,
    )
    // The route gate only authorizes the addressed account, so the record must belong
    // to it; 404 hides other accounts' sources entirely.
    if (source.accountId !== accountId) throw new NotFoundError('SkillSource', sourceId)
    if (source.deletedAt !== null) throw new NotFoundError('SkillSource', sourceId)
    return source
  }

  private async requireInstallation(source: SkillSourceRecord): Promise<number> {
    const installationId = await this.deps.resolveInstallationId(source.accountId)
    if (installationId === null) {
      throw new ValidationError(
        'No GitHub installation is available for this account; connect GitHub before syncing a skill source',
      )
    }
    return installationId
  }

  private listDir(
    source: SkillSourceRecord,
    installationId: number,
    path: string,
    readRef: string,
  ) {
    return this.deps.githubClient.listDirectory(
      installationId,
      { owner: source.repoOwner, repo: source.repoName },
      path,
      readRef,
    )
  }

  /**
   * Reconcile one `<skill>/` directory:
   * - 'skip' — not a skill (no `SKILL.md`), or unreadable/unparseable with NO prior row.
   * - 'kept' — nothing changed; the prior row is current and untouched.
   * - 'stale' — a change WAS detected but couldn't be applied this round (manifest read
   *   back as a 404/non-file, or parsed empty) so the prior row is kept alive rather than
   *   retired. Signals the caller to leave the source pin behind and retry next sync.
   * - 'upserted' — the manifest or its resource manifest moved and was written.
   */
  private async syncSkillDir(
    source: SkillSourceRecord,
    dirName: string,
    dirPath: string,
    skillId: string,
    prior: AccountSkillRecord | undefined,
    installationId: number,
    readRef: string,
    now: number,
  ): Promise<'skip' | 'kept' | 'stale' | 'upserted'> {
    const entries = await this.listDir(source, installationId, dirPath, readRef)
    const manifest = entries.find((e) => e.type === 'file' && isSkillManifest(e.name))
    if (!manifest) return 'skip' // not a skill directory (SKILL.md removed → prior tombstoned)
    const resources: SkillResource[] = entries
      .filter((e) => e.type === 'file' && !isSkillManifest(e.name))
      .map((e) => ({ path: e.path, sha: e.sha, size: e.size ?? 0 }))
      .sort((a, b) => a.path.localeCompare(b.path))

    // Fast path: the SKILL.md blob sha is unchanged AND the resource manifest matches,
    // so nothing in this skill changed — keep the prior row untouched.
    if (prior && prior.sourceSha === manifest.sha && sameResources(prior.resources, resources)) {
      return 'kept'
    }

    // Resource-only change: SKILL.md is unchanged but a sibling resource moved. The
    // manifest content (name/description/instructions) is identical, so refresh only the
    // resource manifest + pinned commit without re-fetching the body.
    if (prior && prior.sourceSha === manifest.sha) {
      await this.deps.accountSkillRepository.upsert({
        ...prior,
        resources,
        pinnedCommit: readRef,
        updatedAt: now,
        deletedAt: null,
      })
      return 'upserted'
    }

    const file = await this.deps.githubClient.getFileContent(
      installationId,
      { owner: source.repoOwner, repo: source.repoName },
      manifest.path,
      readRef,
    )
    // Unreadable / unparseable this round: keep a prior skill alive rather than retiring
    // it over a transient read or an in-progress edit; with no prior there's nothing to keep.
    // Either way a change was detected (the manifest sha moved) but not applied, so report
    // 'stale' so the source pin is NOT advanced and the next sync re-reads.
    if (!file) return prior ? 'stale' : 'skip'
    const parsed = parseSkillManifest(dirName, file.content)
    if (!parsed) return prior ? 'stale' : 'skip'

    await this.deps.accountSkillRepository.upsert({
      skillId,
      accountId: source.accountId,
      name: parsed.name,
      description: parsed.description,
      instructions: parsed.instructions,
      resources,
      sourceId: source.id,
      sourcePath: manifest.path,
      sourceSha: file.sha,
      pinnedCommit: readRef,
      createdAt: prior?.createdAt ?? now,
      updatedAt: now,
      deletedAt: null,
    })
    return 'upserted'
  }
}

function sameResources(a: SkillResource[], b: SkillResource[]): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    if (a[i]!.path !== b[i]!.path || a[i]!.sha !== b[i]!.sha) return false
  }
  return true
}

function toWire(record: SkillSourceRecord): SkillSource {
  return {
    id: record.id,
    accountId: record.accountId,
    repoOwner: record.repoOwner,
    repoName: record.repoName,
    gitRef: record.gitRef,
    dirPath: record.dirPath,
    lastSyncedCommit: record.lastSyncedCommit,
    lastSyncedAt: record.lastSyncedAt,
    createdAt: record.createdAt,
  }
}
