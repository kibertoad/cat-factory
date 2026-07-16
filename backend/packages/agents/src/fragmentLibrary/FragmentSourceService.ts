import type {
  FragmentOwnerKind,
  FragmentSource,
  FragmentSourceStatus,
  FragmentSyncResult,
  LinkFragmentSourceInput,
} from '@cat-factory/kernel'
import { NotFoundError, ValidationError, assertFound } from '@cat-factory/kernel'
import type { Clock, IdGenerator } from '@cat-factory/kernel'
import type { GitHubClient, RepoContentEntry } from '@cat-factory/kernel'
import type {
  FragmentSourceRecord,
  FragmentSourceRepository,
  PromptFragmentRecord,
  PromptFragmentRepository,
} from '@cat-factory/kernel'
import { isMarkdownFile, parseFragmentMarkdown, slugFromPath } from './fragment-source.logic.js'
import {
  normalizeDirPath,
  probeRepoSourceStatus,
  syncRepoSource,
} from '../repoSourceSync/repo-source-sync.js'

/**
 * Resolve the GitHub App installation id that can read a tier's repos. A
 * workspace-owned source reads through the workspace's installation; an
 * account-owned one through the account's. Returns null when no installation is
 * available, so a sync fails with a clear error rather than a silent empty pull.
 */
export type ResolveFragmentInstallationId = (
  ownerKind: FragmentOwnerKind,
  ownerId: string,
) => Promise<number | null>

export interface FragmentSourceServiceDependencies {
  fragmentSourceRepository: FragmentSourceRepository
  promptFragmentRepository: PromptFragmentRepository
  githubClient: GitHubClient
  resolveInstallationId: ResolveFragmentInstallationId
  idGenerator: IdGenerator
  clock: Clock
  /**
   * Drops the cached merged catalog for a tier after this service mutates its
   * fragments (sync/unlink) — wired to
   * {@link FragmentLibraryService.invalidateCatalogTier} by the composition root.
   * Absent (tests) ⇒ no cache to keep coherent.
   */
  invalidateCatalog?: (ownerKind: FragmentOwnerKind, ownerId: string) => Promise<void>
}

/**
 * Repo-sourced fragments (ADR 0006 §3, §6): link a repo directory of Markdown
 * guidelines to a tier, resync it (read the tree, upsert changed files, tombstone
 * removed ones), and answer the cheap "check for changes" without writing. Reads
 * go through the account's existing GitHub installation — no new credential store.
 * Sync runs inline (bounded directory); the sha-keyed upsert is idempotent so it
 * can later move behind a Workflow safely.
 *
 * The full fragment bodies are cached on our side (in `prompt_fragments`), so the
 * run path never re-fetches. Staleness is therefore a **single lightweight commit
 * probe**: sync pins the source dir's head commit sha, and {@link status} compares
 * that stored commit against the current head — no directory listing, no body reads.
 */
export class FragmentSourceService {
  constructor(private readonly deps: FragmentSourceServiceDependencies) {}

  /** Linked sources for a tier + their last-synced state. */
  async list(ownerKind: FragmentOwnerKind, ownerId: string): Promise<FragmentSource[]> {
    const rows = await this.deps.fragmentSourceRepository.listByOwner(ownerKind, ownerId)
    return rows.map(toWire)
  }

  /** Link a repo directory as a fragment source. Does not sync (call {@link sync}). */
  async link(
    ownerKind: FragmentOwnerKind,
    ownerId: string,
    input: LinkFragmentSourceInput,
  ): Promise<FragmentSource> {
    const now = this.deps.clock.now()
    const record: FragmentSourceRecord = {
      id: this.deps.idGenerator.next('frgsrc'),
      ownerKind,
      ownerId,
      repoOwner: input.repoOwner.trim(),
      repoName: input.repoName.trim(),
      gitRef: input.gitRef?.trim() || 'HEAD',
      dirPath: normalizeDirPath(input.dirPath),
      lastSyncedCommit: null,
      lastSyncedAt: null,
      createdAt: now,
      deletedAt: null,
    }
    await this.deps.fragmentSourceRepository.upsert(record)
    return toWire(record)
  }

  /** Unlink a source and tombstone every fragment it produced. */
  async unlink(ownerKind: FragmentOwnerKind, ownerId: string, sourceId: string): Promise<void> {
    const source = await this.require(ownerKind, ownerId, sourceId)
    const now = this.deps.clock.now()
    const fragments = await this.deps.promptFragmentRepository.listBySource(sourceId)
    for (const f of fragments) {
      await this.deps.promptFragmentRepository.softDelete(f.ownerKind, f.ownerId, f.fragmentId, now)
    }
    await this.deps.fragmentSourceRepository.softDelete(source.id, now)
    if (fragments.length > 0) await this.deps.invalidateCatalog?.(ownerKind, ownerId)
  }

  /**
   * Resync a source: list the directory, upsert every Markdown file whose blob
   * sha changed, tombstone fragments no longer produced by any current file, and
   * stamp the source dir's head commit sha. Idempotent — re-running with no upstream
   * change touches nothing.
   */
  async sync(
    ownerKind: FragmentOwnerKind,
    ownerId: string,
    sourceId: string,
  ): Promise<FragmentSyncResult> {
    const source = await this.require(ownerKind, ownerId, sourceId)
    // The installation is invariant across the whole sync — resolve it ONCE here,
    // never per file (the per-entry reads share it via the shared helper).
    const installationId = await this.requireInstallation(source)
    // The shared repo-source engine (repoSourceSync) owns the mechanics — pin the head
    // commit before reading, sweep tombstones by produced id, stamp the sync state,
    // invalidate only when a row changed. The fragment differentiator is the reconcile:
    // one Markdown file per fragment, change-detected by blob sha.
    return syncRepoSource<PromptFragmentRecord>({
      source,
      installationId,
      githubClient: this.deps.githubClient,
      now: this.deps.clock.now(),
      listExisting: () => this.deps.promptFragmentRepository.listBySource(sourceId),
      existingId: (f) => f.fragmentId,
      reconcile: async ({ readRef, now }, existing) => {
        const entries = await this.readMarkdown(source, installationId, readRef)
        const existingByPath = new Map(existing.map((f) => [f.sourcePath ?? '', f]))
        // Keyed by fragment id too, so `syncEntry` can inherit an existing fragment's
        // version/createdAt when a RENAME reaches it under a new path (path lookup misses,
        // id lookup hits) rather than silently resetting them to defaults.
        const existingById = new Map(existing.map((f) => [f.fragmentId, f]))
        const liveIds = new Set<string>()
        let upserted = 0
        let unchanged = 0
        for (const entry of entries) {
          const prior = existingByPath.get(entry.path)
          if (prior && prior.sourceSha === entry.sha) {
            unchanged++
            liveIds.add(prior.fragmentId)
            continue
          }
          const syncedId = await this.syncEntry(
            source,
            entry,
            existingById,
            now,
            installationId,
            readRef,
          )
          if (syncedId) {
            liveIds.add(syncedId)
            upserted++
          } else if (prior) {
            // Unreadable/unparseable this round: keep the prior fragment alive rather
            // than retiring guidance over a transient read or an in-progress edit.
            liveIds.add(prior.fragmentId)
          }
        }
        return { liveIds, upserted, unchanged }
      },
      tombstone: (f, now) =>
        this.deps.promptFragmentRepository.softDelete(f.ownerKind, f.ownerId, f.fragmentId, now),
      updateSyncState: (commit, now) =>
        this.deps.fragmentSourceRepository.updateSyncState(source.id, commit, now),
      invalidate: () => this.deps.invalidateCatalog?.(ownerKind, ownerId) ?? Promise.resolve(),
    })
  }

  /**
   * Lightweight "check for changes": read only the source dir's current head commit sha
   * and compare it to the one stored at the last sync. One cheap commit lookup — no
   * directory listing, no file bodies (those are already cached on our side). `changed`
   * is exact at commit granularity: any commit touching the dir (edit, add, remove,
   * rename) advances the head sha.
   */
  async status(
    ownerKind: FragmentOwnerKind,
    ownerId: string,
    sourceId: string,
  ): Promise<FragmentSourceStatus> {
    const source = await this.require(ownerKind, ownerId, sourceId)
    const installationId = await this.requireInstallation(source)
    return probeRepoSourceStatus({ source, installationId, githubClient: this.deps.githubClient })
  }

  // --- internals ----------------------------------------------------------

  private async require(
    ownerKind: FragmentOwnerKind,
    ownerId: string,
    sourceId: string,
  ): Promise<FragmentSourceRecord> {
    const source = assertFound(
      await this.deps.fragmentSourceRepository.get(sourceId),
      'FragmentSource',
      sourceId,
    )
    // The route gates only authorize the addressed owner (account/workspace) prefix, so
    // the record must belong to that owner; 404 hides other tenants' sources entirely.
    if (source.ownerKind !== ownerKind || source.ownerId !== ownerId) {
      throw new NotFoundError('FragmentSource', sourceId)
    }
    if (source.deletedAt !== null) throw new NotFoundError('FragmentSource', sourceId)
    return source
  }

  /** Resolve the GitHub installation that reads this source's tier, or throw cleanly. */
  private async requireInstallation(source: FragmentSourceRecord): Promise<number> {
    const installationId = await this.deps.resolveInstallationId(source.ownerKind, source.ownerId)
    if (installationId === null) {
      throw new ValidationError(
        'No GitHub installation is available for this scope; connect GitHub before syncing a source',
      )
    }
    return installationId
  }

  /**
   * List the source directory and keep only Markdown files (with their shas). Reads at
   * `readRef` — the sync's pinned head commit sha (falls back to the source's `gitRef`).
   */
  private async readMarkdown(
    source: FragmentSourceRecord,
    installationId: number,
    readRef: string,
  ): Promise<RepoContentEntry[]> {
    const entries = await this.deps.githubClient.listDirectory(
      installationId,
      { owner: source.repoOwner, repo: source.repoName },
      source.dirPath,
      readRef,
    )
    return entries.filter((e) => e.type === 'file' && isMarkdownFile(e.name))
  }

  /**
   * Read, parse and upsert one file as a fragment owned by the source's tier.
   * Returns the fragment id it produced, or null when the file was unreadable /
   * unparseable (nothing written).
   */
  private async syncEntry(
    source: FragmentSourceRecord,
    entry: RepoContentEntry,
    existingById: Map<string, PromptFragmentRecord>,
    now: number,
    installationId: number,
    readRef: string,
  ): Promise<string | null> {
    const file = await this.deps.githubClient.getFileContent(
      installationId,
      { owner: source.repoOwner, repo: source.repoName },
      entry.path,
      readRef,
    )
    if (!file) return null
    const parsed = parseFragmentMarkdown(entry.path, file.content)
    if (!parsed) return null

    // Sourced ids are namespaced so two sources can't collide; an explicit
    // frontmatter `id` instead *shadows* a built-in/inherited fragment (ADR 0006).
    const fragmentId = parsed.id?.trim() || `src:${source.id}:${slugFromPath(entry.path)}`
    // Match the existing row by the id THIS file produces, not by path — so a rename
    // (new path, same explicit id) still inherits the fragment's version + createdAt,
    // while a genuinely new id (a fresh file, or a file whose explicit id changed) starts
    // fresh and lets the sweep retire the old id.
    const prior = existingById.get(fragmentId)
    const record: PromptFragmentRecord = {
      fragmentId,
      ownerKind: source.ownerKind,
      ownerId: source.ownerId,
      version: prior?.version ?? '1.0.0',
      title: parsed.title,
      category: parsed.category ?? null,
      summary: parsed.summary,
      body: parsed.body,
      appliesTo: parsed.appliesTo ?? null,
      tags: parsed.tags && parsed.tags.length ? parsed.tags : null,
      sourceId: source.id,
      sourcePath: entry.path,
      sourceSha: file.sha,
      docSource: null,
      docExternalId: null,
      docViaWorkspaceId: null,
      resolvedAt: null,
      createdAt: prior?.createdAt ?? now,
      updatedAt: now,
      deletedAt: null,
    }
    await this.deps.promptFragmentRepository.upsert(record)
    return fragmentId
  }
}

function toWire(record: FragmentSourceRecord): FragmentSource {
  return {
    id: record.id,
    ownerKind: record.ownerKind,
    ownerId: record.ownerId,
    repoOwner: record.repoOwner,
    repoName: record.repoName,
    gitRef: record.gitRef,
    dirPath: record.dirPath,
    lastSyncedCommit: record.lastSyncedCommit,
    lastSyncedAt: record.lastSyncedAt,
    createdAt: record.createdAt,
  }
}
